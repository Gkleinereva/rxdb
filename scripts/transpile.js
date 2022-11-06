process.env['NODE_ENV'] = 'es5';

console.log('# transpiling.. (this takes some time on first run)');
require('events').EventEmitter.defaultMaxListeners = 0;

/**
 * runs the babel-transpile
 * remembers mtime of files and only transpiles the changed ones
 */
const nconf = require('nconf');
const path = require('path');
const fs = require('fs');
const os = require('os');
const walkSync = require('walk-sync');
const shell = require('shelljs');
const existsFile = require('exists-file');
const basePath = path.join(__dirname, '..');

const confLocation = path.join(basePath, '.transpile_state.json');
const cpuCount = os.cpus().length;

const DEBUG = false;

/**
 * key->value | src -> compiled
 */
const TRANSPILE_FOLDERS = [
    {
        source: 'src',
        goals: {
            es5: 'dist/lib',
            es6: 'dist/es'
        }
    },
    {
        source: 'test',
        goals: {
            es5: 'test_tmp'
        }
    }
]

nconf.argv()
    .env()
    .file({
        file: confLocation
    });

async function transpileFile(
    srcLocations,
    outDir,
    env
) {
    DEBUG && console.log('transpile: ' + srcLocations.join(', '));
    // ensure folder exists
    const folder = path.join(outDir);
    if (!fs.existsSync(folder)) {
        shell.mkdir('-p', folder);
    }

    // const outFilePath = 
    // await del.promise([outDir]);
    const cmd = 'cross-env NODE_ENV=' + env +
        ' babel ' +
        srcLocations.join(' ') +
        ' --source-maps' +
        ' --extensions ".ts,.js"' +
        ' --out-dir ' +
        outDir;

    DEBUG && console.dir(cmd);

    const execRes = shell.exec(cmd, {
        async: true
    });
    await new Promise(res => execRes.on('exit', res));

    const exitCode = execRes.exitCode;
    if (exitCode !== 0) {
        console.error('transpiling failed with cmd: ' + cmd);
        process.exit(1);
    }

    if (DEBUG) {
        console.log('transpiled files: ' + srcLocations.join(', '));
    }

    return;
}

async function getFiles() {
    const files = [];
    await Promise.all(
        TRANSPILE_FOLDERS
            // make all file paths absolute
            .map(transpileFolder => {
                transpileFolder.source = path.join(basePath, transpileFolder.source);
                Object.entries(transpileFolder.goals).forEach(([key, value]) => {
                    transpileFolder.goals[key] = path.join(basePath, value);
                });
                return transpileFolder;
            })
            .map(transpileFolder => {
                const srcFolder = transpileFolder.source;
                return walkSync.entries(srcFolder)
                    .filter(entry => !entry.isDirectory())
                    .filter(entry => entry.relativePath.endsWith('.js') || entry.relativePath.endsWith('.ts'))
                    .filter(entry => !entry.relativePath.includes('/node_modules/'))
                    .map(fileEntry => {
                        // ensure goal-file-ending is .js
                        const relativePathSplit = fileEntry.relativePath.split('.');
                        relativePathSplit.pop();
                        relativePathSplit.push('js');
                        Object.entries(transpileFolder.goals).forEach(([env, toFolder]) => {
                            const goalPath = path.join(toFolder, relativePathSplit.join('.'));
                            const fullPath = path.join(fileEntry.basePath, fileEntry.relativePath);

                            const lastTime = parseInt(nconf.get(fileEntry.fullPath), 10);
                            const file = {
                                env,
                                fullPath,
                                relativePath: fileEntry.relativePath,
                                basePath: fileEntry.basePath,
                                mtime: fileEntry.mtime,
                                goalFolder: path.dirname(goalPath),
                                goalPath: goalPath,
                            };
                            if (
                                lastTime !== fileEntry.mtime ||
                                !existsFile.sync(goalPath)
                            ) {
                                files.push(file);
                            }
                        });
                    });
            })
    );

    const filesByGoalFolder = {};
    files.forEach(file => {
        if (!filesByGoalFolder[file.goalFolder]) {
            filesByGoalFolder[file.goalFolder] = [];
        }
        filesByGoalFolder[file.goalFolder].push(file);
    });

    DEBUG && console.dir(filesByGoalFolder);

    return filesByGoalFolder;
}

async function run() {
    const files = await getFiles();


    await Promise.all(
        Object.values(files).map(async (filesWithSameGoalFolder) => {

            const byEnv = {};
            filesWithSameGoalFolder.forEach(row => {
                const env = row.env;
                if (!byEnv[env]) {
                    byEnv[env] = [];
                }
                const ar = byEnv[env];
                ar.push(row);
            });

            await Promise.all(
                Object.entries(byEnv)
                    .map(async ([env, files]) => {
                        await transpileFile(
                            files.map(file => path.join(file.basePath, file.relativePath)),
                            files[0].goalFolder,
                            env
                        );
                        files.forEach(file => nconf.set(file.fullPath, file.mtime));
                    })
            );
        })
    );

    nconf.save(function () {
        DEBUG && console.log('conf saved');
        console.log('# transpiling DONE (' + cpuCount + ' CPUs)');
    });
}
run();

