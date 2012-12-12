
const PATH = require("path");
const FS = require("fs");
const SPAWN = require("child_process").spawn;


exports.for = function(API, plugin) {

	plugin.install = function(packagePath, options) {
        return API.Q.call(function() {
            if (!PATH.existsSync(PATH.join(packagePath, "package.json"))) {
                return;
            }
            function postinstall() {
                // Don't use NPM to call postinstall script and populate ENV with all typical SM ENV variables.
                return callNPM(packagePath, [
                    "run-script",
                    "postinstall"
                ], options);
            }
            if (packagePath === plugin.node.path) {
                return postinstall();
            }
            return API.SM_CORE.for(packagePath).install(options).then(function() {
                return postinstall();
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
				var coverageTestCommand = testCommand.replace(/^node\s*/, "");
				coverageTestCommand = coverageTestCommand.replace(/\.js$/, "") + ".js";
				if (PATH.existsSync(PATH.join(node.path, coverageTestCommand))) {
					testCommand = "istanbul cover --dir .sourcemint/coverage -- " + coverageTestCommand;
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

