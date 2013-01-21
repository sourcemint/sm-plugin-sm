
const PATH = require("path");
const FS = require("graceful-fs");
const SPAWN = require("child_process").spawn;
const COPY = require("ncp").ncp;


exports.for = function(API, plugin) {


    plugin.resolveLocator = function(locator, options) {
        var self = this;

        if (!/^https?:\/\//.test(locator.descriptor.pointer)) {

throw new Error("TODO: Resolve pinf-style uris (github.com/sourcemint/loader/~0.1.0).");

        }

        return self.node.getPlugin("archive").then(function(pm) {
            return pm.resolveLocator(locator, options);
        });
    }

	plugin.install = function(packagePath, options) {
        return API.Q.call(function() {
            if (!PATH.existsSync(PATH.join(packagePath, "package.json"))) {
                return;
            }
            function install() {
                // Don't use NPM to call 'install' script and populate ENV with all typical SM ENV variables.
                return callNPM(packagePath, [
                    "run-script",
                    "install"
                ], options);
            }
            if (packagePath === plugin.node.path) {
                return install();
            }
            return API.SM_CORE.for(packagePath).install(options).then(function() {
                return install();
            });
        });
	}

	plugin.test = function(node, options) {
		if (!node.descriptors.package.scripts || !node.descriptors.package.scripts.test) {
            API.TERM.stdout.writenl("\0yellow(No `scripts.test` property found in package descriptor for package '" + node.path + "'.\0)");
            return API.Q.resolve();
		}

		var testCommand = node.descriptors.package.scripts.test;

		if (options.cover) {
			if (/^(?:node\s*)?(\S*\.js)$/.test(testCommand)) {
				// TODO: Support other test coverage tools via config and relocate impl into separate plugins.
                //       Relocate this to `freedom-platform/dev`.
				var coverageTestCommand = testCommand.replace(/^node\s*/, "");
				coverageTestCommand = coverageTestCommand.replace(/\.js$/, "") + ".js";
				if (PATH.existsSync(PATH.join(node.path, coverageTestCommand))) {
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

    plugin.export = function(path, options) {
        return API.Q.call(function() {
            if (PATH.existsSync(path)) {
                if (!options.delete) {
                    API.TERM.stdout.writenl("\0red(" + "Export target directory '" + path + "' already exists. Use --delete." + "\0)");
                    throw true;
                }
                API.FS_RECURSIVE.rmdirSyncRecursive(path);
            }
            API.FS_RECURSIVE.mkdirSyncRecursive(path);


            var ignoreRules = {
                // Rules that match the top of the tree (i.e. prefixed with `/`).
                top: {},
                // Rules that apply to every level.
                every: {},
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
                    var scope = (/^\//.test(rule)) ? "top" : "every";
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
                    if (!PATH.existsSync(PATH.join(plugin.node.path, basename))) return;
                    if (ignoreRules.filename !== null) return;
                    ignoreRules.filename = basename;
                    FS.readFileSync(PATH.join(plugin.node.path, basename)).toString().split("\n").forEach(function(rule) {
                        if (!rule) return;
                        insert(rule);
                    });
                });
                if (ignoreRules.filename === null) {
                    // Default rules.
                    insert(".git/");
                    insert(".DS_Store");
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
                                if (!ignore("dir")) {
                                    list[subPath + "/" + basename] = {
                                        dir: true
                                    };
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
                function copy() {
                    try {
                        var paths = roots.shift();
                        if (paths[2]) {
                            FS.unlinkSync(paths[1]);
                        }
                        COPY(paths[0], paths[1], {
                            filter: function(path) {
                                if (path === fromPath) return true;
                                path = ((paths[2])?paths[2]:"") + path.substring(paths[0].length);
                                if (list[path]) {
                                    if (typeof list[path].symlink !== "undefined" && paths[0] != list[path].symlinkReal) {
                                        roots.push([list[path].symlinkReal, PATH.join(toPath, path), path]);
                                    }
                                    return true;
                                }
                                return false;
                            }
                        }, function(err) {
                            if (err) return callback(err);
                            if (roots.length === 0) return callback(null);
                            return copy();
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
                        if (!node.descriptors.package) return false;

                        var descriptorPath = null;
                        if (circularNode) {
                            descriptorPath = PATH.join(path, circularNode.summary.relpath, node.summary.relpath.substring(circularNode.circular.summary.relpath.length), "package.json");
                        } else {
                            descriptorPath = PATH.join(path, node.summary.relpath, "package.json");
                        }

                        var descriptor = API.UTIL.deepCopy(node.descriptors.package);

                        // Remove properties that are not needed at runtime.
                        delete descriptor.version;
                        delete descriptor.pm;
                        delete descriptor.bugs;
                        delete descriptor.homepage;
                        delete descriptor.description;
                        delete descriptor.repository;
                        delete descriptor.repositories;
                        delete descriptor.scripts;
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
                        // sm specific.
                        delete descriptor.mappings;
                        delete descriptor.devMappings;
                        // npm specific.
                        delete descriptor.dependencies;
                        delete descriptor.devDependencies;
                        delete descriptor._id;
                        delete descriptor._from;

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
                        descriptor.bundleDependencies = Object.keys(node.children);

                        // TODO: Order properties in standard sequence.

                        if (!PATH.existsSync(descriptorPath)) return;

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

                    options.logger.info("Found '" + (stats.totalFiles - stats.ignoredFiles) + "' files (size: " + stats.totalSize + " bytes) while ignoring '" + stats.ignoredFiles + "' files based on '" + stats.ignoreRulesCount + "' ignore rules.");

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

