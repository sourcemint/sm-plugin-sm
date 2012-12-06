
const PATH = require("path");
const FS = require("fs");
const SPAWN = require("child_process").spawn;


exports.for = function(API, plugin) {

	plugin.install = function(packagePath, options) {
	    return callNPM(packagePath, [
	        "run-script",
	        "postinstall"
	    ], options);
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

