
const PATH = require("path");
const FS = require("graceful-fs");
const SPAWN = require("child_process").spawn;
const KNOX = require("knox");


exports.for = function(API, plugin) {


    plugin.resolveLocator = function(locator, options, callback) {
        var self = this;

        if (!/^https?:\/\//.test(locator.descriptor.pointer)) {

throw new Error("TODO: Resolve pinf-style uris (github.com/sourcemint/loader/~0.1.0).");

        }

        return self.node.getPlugin("archive", function(err, pm) {
            if (err) return callback(err);
            return pm.resolveLocator(locator, options, callback);
        });
    }

	plugin.install = function(packagePath, options) {
        return API.Q.fcall(function() {
            if (!API.FS.existsSync(PATH.join(packagePath, "package.json"))) {
                return;
            }
            function install() {
                if (!plugin.node.summary.scripts.install) return;
                // Don't use NPM to call 'install' script and populate ENV with all typical SM ENV variables.
                return callNPM(packagePath, [
                    "run-script",
                    "install"
                ], options);
            }
            if (packagePath === plugin.node.path) {
                return install();
            }
            var smCore = API.SM_CORE.for(packagePath, plugin.core);
            return smCore.__init(options).then(function() {
                return smCore.install(options).then(function() {
                    return install();
                });
            });
        });
	}

	plugin.test = function(node, options) {
		if (!node.descriptor.package.scripts || !node.descriptor.package.scripts.test) {
            API.TERM.stdout.writenl("\0yellow(No `scripts.test` property found in package descriptor for package '" + node.path + "'.\0)");
            return API.Q.resolve();
		}

		var testCommand = node.descriptor.package.scripts.test;

		if (options.cover) {
			if (/^(?:node\s*)?(\S*\.js)$/.test(testCommand)) {
				// TODO: Support other test coverage tools via config and relocate impl into separate plugins.
                //       Relocate this to `freedom-platform/dev`.
				var coverageTestCommand = testCommand.replace(/^node\s*/, "");
				coverageTestCommand = coverageTestCommand.replace(/\.js$/, "") + ".js";
				if (API.FS.existsSync(PATH.join(node.path, coverageTestCommand))) {
					testCommand = "istanbul cover --dir .sm/coverage -- " + coverageTestCommand;
				}
			} else {
	            API.TERM.stdout.writenl("\0yellow(Cannot cover tests for '" + node.path + "' as `scripts.test` does not point to a javascript file.\0)");
	            return API.Q.resolve();
			}
		}
		var opts = API.UTIL.copy(options);
		opts.cwd = node.path;
		opts.env = {
			PATH: API.OS.getEnvPath([
				PATH.join(node.path, "mapped_packages/.bin"),
				PATH.join(node.path, "node_modules/.bin"),
				PATH.join(__dirname, "node_modules/.bin")
			])
			// TODO: Populate ENV with all typical SM ENV variables.
		}
		testCommand = testCommand.split(" ");
		return API.OS.spawnInline(testCommand.shift(), testCommand, opts);
	}


    plugin.publish = function(options) {
        var self = this;

        var archivePath = PATH.join(self.node.path, self.node.summary.name + "-" + self.node.summary.version + ".tgz");

        function upload() {
            var deferred = API.Q.defer();

            // TODO: Get a temporary key from `sourcemint.org`.
            var client = KNOX.createClient(plugin.core.getCredentials(["github.com/sourcemint/sm-plugin-sm/0", "s3"]));

            var targetUri = PATH.join(self.node.summary.uid, "-archives", PATH.basename(archivePath));

            console.log("Publishing '" + archivePath + "' to '" + "http://s3.sourcemint.org/" + targetUri + "'");

            client.headFile(targetUri, {
                "Content-Type": "application/x-gzip",
                "x-amz-acl": (self.node.summary.public)? "public-read" : "private"
            }, function(err, res) {
                if (err) return deferred.reject(err);
                if (res.statusCode === 200) return deferred.resolve();
                client.putFile(archivePath, targetUri, {
                    "Content-Type": "application/x-gzip",
                    "x-amz-acl": (self.node.summary.public)? "public-read" : "private"
                }, function(err, res) {
                    if (err) return deferred.reject(err);
                    if (res.statusCode === 200) return deferred.resolve();
                    var response = "";
                    res.on("data", function(chunk) {
                        response += chunk.toString();
                    });
                    return deferred.reject(new Error("Got status code '" + res.statusCode + "' with message: " + response));
                });
            });

            return deferred.promise;
        }

        if (API.FS.existsSync(archivePath)) {
            return upload();
        } else {
            // TODO: Don't use `npm` and just create an archive. Need to respect `.npmignore` files if present.
            return callNPM(self.node.path, [
                "pack"
            ], options).then(function() {
                return upload();
            });
        }
    }

    plugin.deploy = function(options) {
        var self = this;

        if (!self.node.summary.scripts.deploy) return API.Q.resolve();

        var opts = API.UTIL.copy(options);
/*
        opts.verbose = true;
        return callNPM(self.node.path, [
            "run-script",
            "deploy"
        ], opts);
*/
        var command = API.HELPERS.makeNodeCommanFromString(self.node.summary.scripts.deploy);
        return API.OS.spawnInline(command.split(" ").shift(), command.split(" ").slice(1), {
            cwd: self.node.path,
            env: {
                PWD: self.node.path
            }
        });
    }

    plugin.export = function(path, options) {
        return API.Q.fcall(function() {
            if (API.FS.existsSync(path)) {
                if (!options.delete) {
                    API.TERM.stdout.writenl("\0red(" + "Export target directory '" + path + "' already exists. Use --delete." + "\0)");
                    throw true;
                }
                API.FS.removeSync(path);
            }
            API.FS.mkdirsSync(path);

            var ignoreRules = {
                // Rules that match the top of the tree (i.e. prefixed with `/`).
                top: {},
                // Rules that apply to every level.
                every: {},
                // Rules that include specific files and directories.
                include: {},
                filename: null
            };

            var stats = {
                ignoreRulesCount: 0,
                totalFiles: 0,
                ignoredFiles: 0,
                totalSize: 0
            };

            function loadIgnoreRules(callback) {
                function insert(rule) {
                    var key = rule.split("*")[0];
                    var scope = /^!/.test(rule) ? "include" : ( /^\//.test(rule) ? "top" : "every" );
                    if (scope === "include") {
                        key = key.substring(1);
                        rule = rule.substring(1);
                    }
                    if (!ignoreRules[scope][key]) {
                        ignoreRules[scope][key] = [];
                    }
                    var re = new RegExp(rule.replace("*", "[^\\/]*?"));
                    ignoreRules[scope][key].push(function applyRule(path) {
                        if (path === rule || re.test(path)) return true;
                        return false;
                    });
                    stats.ignoreRulesCount += 1;
                }
                [
                    ".distignore",
                    ".npmignore",
                    ".gitignore"
                ].forEach(function(basename) {
                    if (!API.FS.existsSync(PATH.join(plugin.node.path, basename))) return;
                    if (ignoreRules.filename !== null) return;
                    ignoreRules.filename = basename;
                    FS.readFileSync(PATH.join(plugin.node.path, basename)).toString().split("\n").forEach(function(rule) {
                        if (!rule) return;
                        insert(rule);
                    });
                });
                if (ignoreRules.filename === null) {
                    // Default rules.
                    /*
                    insert(".git/");
                    insert(".gitignore");
                    insert(".npmignore");
                    insert(".sm/");
                    insert(".rt/");
                    insert(".DS_Store");
                    insert(".program.json");
                    insert(".package.json");
                    */
                    insert(".*");
                    insert(".*/");
                    insert("/dist/");
                    insert("program.dev.json");
                }
                return callback(null);
            }

            function walkTree(subPath, callback) {
                var list = {};
                var c = 0;
                FS.readdir(PATH.join(plugin.node.path, subPath), function(err, files) {
                    if (err) return callback(err);
                    if (files.length === 0) {
                        return callback(null, list);
                    }
                    function error(err) {
                        c = -1;
                        return callback(err);
                    }
                    function done() {
                        if (c !== 0) return;
                        c = -1;
                        return callback(null, list);
                    }       
                    files.forEach(function(basename) {
                        if (c === -1) return;

                        function ignore(type) {
                            function select(ruleGroups, path) {
                                var rules = null;
                                if (ruleGroups[path]) {
                                    rules = ruleGroups[path];
                                } else {
                                    for (var prefix in ruleGroups) {
                                        if (path.substring(0, prefix.length) === prefix) {
                                            rules = ruleGroups[prefix];
                                            break;
                                        }
                                    }
                                }
                                if (!rules && ruleGroups[""]) {
                                    rules = ruleGroups[""];
                                }
                                if (rules) {
                                    for (var i=0 ; i<rules.length ; i++) {
                                        if (rules[i](path)) {
                                            return true;
                                        }
                                    }
                                    return false;
                                }
                            }
                            if (select(ignoreRules.include, subPath + "/" + basename + ((type === "dir") ? "/" : ""))) {
                                return false;
                            }
                            if (select(ignoreRules.top, subPath + "/" + basename + ((type === "dir") ? "/" : ""))) {
                                return true;
                            }
                            // All deeper nodes.
                            return select(ignoreRules.every, basename + ((type === "dir") ? "/" : ""));
                        }

                        c += 1;
                        FS.lstat(PATH.join(plugin.node.path, subPath, basename), function(err, stat) {
                            if (err) return error(err);
                            c -= 1;
                            if (stat.isSymbolicLink()) {
                                c += 1;
                                FS.readlink(PATH.join(plugin.node.path, subPath, basename), function(err, val) {
                                    if (err) return error(err);
                                    c -= 1;

                                    // TODO: Detect circular links.

                                    var linkDir = null;
                                    try {
                                        linkDir = FS.realpathSync(PATH.resolve(PATH.join(plugin.node.path, subPath), val));
                                    } catch(err) {
                                        if (err.code === "ENOENT") return done();
                                        throw err;
                                    }

                                    c += 1;
                                    FS.lstat(linkDir, function(err, linkStat) {
                                        if (err) return error(err);
                                        c -= 1;

                                        stats.totalFiles += 1;

                                        if (!ignore( linkStat.isDirectory() ? "dir" : "file")) {
                                            list[subPath + "/" + basename] = {
                                                mtime: stat.mtime.getTime(),
                                                dir: linkStat.isDirectory() || false,
                                                symlink: val,
                                                symlinkReal: linkDir
                                            };
                                        } else {
                                            stats.ignoredFiles += 1;
                                        }
                                        if (linkStat.isDirectory()) {
                                            c += 1;
                                            walkTree(subPath + "/" + basename, function(err, subList) {
                                                if (err) return error(err);
                                                c -= 1;
                                                for (var key in subList) {
                                                    list[key] = subList[key];
                                                }
                                                done();
                                            });
                                        } else {
                                            done();
                                        }
                                    });

                                });
                            } else
                            if (stat.isDirectory()) {
                                var walk = false;
                                if (!ignore("dir")) {
                                    list[subPath + "/" + basename] = {
                                        dir: true
                                    };
                                    walk = true;
                                } else {
                                    for (var path in ignoreRules.include) {
                                        if (path.substring(0, (subPath + "/" + basename).length) === (subPath + "/" + basename)) {
                                            walk = true;
                                            break;
                                        }
                                    }
                                }
                                if (walk) {
                                    c += 1;
                                    walkTree(subPath + "/" + basename, function(err, subList) {
                                        if (err) return error(err);
                                        c -= 1;
                                        for (var key in subList) {
                                            list[key] = subList[key];
                                        }
                                        done();
                                    });
                                }
                            } else
                            if (stat.isFile()) {
                                stats.totalFiles += 1;
                                if (!ignore("file")) {
                                    list[subPath + "/" + basename] = {
                                        mtime: (stats.totalSize += stat.mtime.getTime()),
                                        size: stat.size
                                    };
                                } else {
                                    stats.ignoredFiles += 1;
                                }
                            }
                            done();
                        });
                    });
                    done();
                });
            }

            function copyFiles(fromPath, toPath, list, callback) {

                var roots = [
                    [fromPath, toPath, false]
                ];
                for (var path in ignoreRules.include) {
                    roots.push([PATH.join(fromPath, path), PATH.join(toPath, path), false]);
                }

                function copy() {
                    try {
                        var paths = roots.shift();
                        if (paths[2]) {
                            FS.unlinkSync(paths[1]);
                        }
                        options.logger.debug("Copying " + paths[0] + " to " + paths[1]);

                        function next() {
                            if (roots.length === 0) return callback(null);
                            return copy();
                        }

                        API.FS.mkdirs(PATH.dirname(paths[1]));

                        API.COPY(paths[0], paths[1], {
                            // Return `true` to copy.
                            filter: function(path) {
                                if (path === paths[0]) return true;
                                path = ((paths[2])?paths[2]:"") + path.substring(paths[0].length);
                                if (list[path]) {
                                    // If we encounter a symlink we enqueue the resolved path to pull in the external sources.
                                    if (typeof list[path].symlink !== "undefined" && paths[0] != list[path].symlinkReal) {
                                        roots.push([list[path].symlinkReal, PATH.join(toPath, path), path]);
                                    }
                                    return true;
                                }
                                return false;
                            }
                        }, function(err) {
                            if (err) return callback(err);
                            return next();
                        });
                    } catch(err) {
                        return callback(err);
                    }
                }
                copy();
            }

            function updatePackageDescriptors(callback) {

                function update(node, circularNode) {
                    try {

                        // TODO: Always write a package descriptor even if original package did not have one?
                        if (!node.descriptor.package) return false;

                        var descriptorPath = null;
                        if (circularNode) {
                            descriptorPath = PATH.join(path, circularNode.summary.relpath, node.summary.relpath.substring(circularNode.circular.summary.relpath.length), "package.json");
                        } else {
                            descriptorPath = PATH.join(path, node.summary.relpath, "package.json");
                        }

                        var descriptor = {};
                        if (API.FS.existsSync(PATH.join(node.path, "package.json"))) {
                            descriptor = JSON.parse(API.FS.readFileSync(PATH.join(node.path, "package.json")));
                        }

                        // Remove properties that are not needed at runtime.
                        delete descriptor.version;
                        delete descriptor.pm;
                        delete descriptor.bugs;
                        delete descriptor.homepage;
                        delete descriptor.description;
                        delete descriptor.repository;
                        delete descriptor.repositories;
                        delete descriptor.name;
                        delete descriptor.publish;
                        delete descriptor.private;
                        delete descriptor.license;
                        delete descriptor.licenses;
                        delete descriptor.author;
                        delete descriptor.maintainers;
                        delete descriptor.contributors;
                        delete descriptor.readme;
                        delete descriptor.dist;
                        delete descriptor.keywords;
                        delete descriptor.readmeFilename;
                        delete descriptor._id;
                        delete descriptor._from;

                        // Go through all bin paths to ensure they exist.
                        if (descriptor.bin) {
                            for (var name in descriptor.bin) {
                                if (!API.FS.existsSync(PATH.join(path, node.summary.relpath, descriptor.bin[name]))) {
                                    delete descriptor.bin[name];
                                }
                            }
                            if (Object.keys(descriptor.bin).length === 0) {
                                delete descriptor.bin;
                            }
                        }

                        // Set some required properties.
                        descriptor.uid = node.summary.uid;
                        if (node.summary.rev) {
                            descriptor.rev = node.summary.rev;
                        }
                        descriptor.name = node.summary.name;
                        if (node.summary.version) {
                            descriptor.version = node.summary.version;
                        }
                        descriptor.pm = node.summary.pm.install;

                        var dependencies = Object.keys(node.children);
                        descriptor.bundleDependencies = [];
                        dependencies.forEach(function(dependency) {
                            if (API.FS.existsSync(PATH.join(path, node.summary.relpath, "node_modules", dependency))) {
                                descriptor.bundleDependencies.push(dependency);
                            }
                        });
                        [
                            "mappings",
                            "devMappings",
                            "dependencies",
                            "devDependencies"
                        ].forEach(function(name) {
                            if (descriptor[name] && API.UTIL.len(descriptor[name]) === 0) {
                                delete descriptor[name];
                            }
                        });

                        // TODO: Order properties in standard sequence.

                        if (!API.FS.existsSync(descriptorPath)) return;

                        FS.writeFileSync(descriptorPath, JSON.stringify(descriptor, null, 4));

                    } catch(err) {
                        return callback(err);
                    }
                }

                function traverse(node, circularNode) {
                    node.traverse(function(node) {
                        if (node.circular) {
                            node.circular.traverse(function(subNode) {
                                traverse(subNode, node);
                            });
                        }
                        update(node, circularNode);
                    });
                }

                traverse(plugin.node);

                return callback(null);
            }

            var deferred = API.Q.defer();

            options.logger.info("Exporting source files from '" + plugin.node.path + "' to '" + path + "' based on '.distignore|.npmignore|.gitignore' rules.");

            loadIgnoreRules(function(err) {
                if (err) return deferred.reject(err);

                walkTree("", function(err, list) {
                    if (err) return deferred.reject(err);

                    options.logger.info("Found '" + (stats.totalFiles - stats.ignoredFiles) + "' files (size: " + stats.totalSize + " bytes) after ignoring '" + stats.ignoredFiles + "' files based on '" + stats.ignoreRulesCount + "' ignore rules.");

                    copyFiles(plugin.node.path, path, list, function(err) {
                        if (err) return deferred.reject(err);

                        options.logger.info("Exported files to: " + path);

                        updatePackageDescriptors(function(err) {
                            if (err) return deferred.reject(err);

                            options.logger.info("Updated package descriptors in exported packages.");

                            return deferred.resolve();
                        });
                    });
                });
            });

            return deferred.promise;
        });
    }

    function callNPM(basePath, args, options) {

        options = options || {};

        var deferred = API.Q.defer();

        if (options.verbose) {
            API.TERM.stdout.writenl("\0cyan(Running: npm " + args.join(" ") + " (cwd: " + basePath + ")\0)");
        }

        var opts = {
            cwd: basePath
        };
        if (options.env) {
            opts.env = UTIL.copy(process.env);
            for (var key in options.env) {
                opts.env[key] = options.env[key];
            }
        }

        var proc = SPAWN("npm", args, opts);
        var buffer = "";

        proc.on("error", function(err) {
            deferred.reject(err);
        });

        proc.stdout.on("data", function(data) {
            if (options.verbose) {
                API.TERM.stdout.write(data.toString());
            }
            buffer += data.toString();
        });
        proc.stderr.on("data", function(data) {
            if (options.verbose) {
                API.TERM.stderr.write(data.toString());
            }
            buffer += data.toString();
        });
        proc.on("exit", function(code) {
            if (code !== 0) {
                API.TERM.stdout.writenl("\0red(" + buffer + "\0)");
                deferred.reject(new Error("NPM error"));
                return;
            }
            if (/npm ERR!/.test(buffer)) {
                
                // WORKAROUND: NPM sometimes gives this error but all seems to be ok.
                if (/cb\(\) never called!/.test()) {

                    TERM.stdout.writenl("\0red(IGNORING NPM EXIT > 0 AND HOPING ALL OK!\0)");

                } else {

                    deferred.reject(new Error("NPM error: " + buffer));
                    return;
                }
            }
            deferred.resolve();
        });

        return deferred.promise;
    }
}

