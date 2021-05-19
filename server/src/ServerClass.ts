/**
  * This Source Code Form is subject to the terms of the Mozilla Public
  * License, v. 2.0. If a copy of the MPL was not distributed with this
  * file, You can obtain one at http://mozilla.org/MPL/2.0/.
  *
  * Copyright (c) 2011-2019 ETH Zurich.
  */
 
'use strict'
import { ViperServerService } from './ViperServerService'

import { IConnection, TextDocuments, PublishDiagnosticsParams } from 'vscode-languageserver'
import { Common, ProgressParams, Command, LogParams, SettingsCheckedParams, Position, Range, StepsAsDecorationOptionsResult, StateChangeParams, BackendReadyParams, Stage, Backend, Commands, LogLevel } from './ViperProtocol'
import { BackendService } from './BackendService'
import { VerificationTask } from './VerificationTask'
import { Log } from './Log'
import { Settings } from './Settings'
import * as pathHelper from 'path'
import * as fs from 'fs'
import * as http from 'http'
import * as os from 'os'
import * as globToRexep from 'glob-to-regexp'
import * as mkdirp from 'mkdirp'
import * as DecompressZip from 'decompress-zip'

export class Server {
    static backend: Backend;
    static tempDirectory: string = pathHelper.join(os.tmpdir(), ".vscode");
    static backendOutputDirectory: string = os.tmpdir();
    static executedStages: Stage[];
    static connection: IConnection;
    static documents: TextDocuments = new TextDocuments();
    static verificationTasks: Map<string, VerificationTask> = new Map();
    static backendService: BackendService = new ViperServerService();
    static debuggedVerificationTask: VerificationTask;
    static startingOrRestarting: boolean = false;
    static viperFileEndings: string[];

    static stage(): Stage {
        if (this.executedStages && this.executedStages.length > 0) {
            return this.executedStages[this.executedStages.length - 1];
        }
        else return null;
    }

    static refreshEndings(): Promise<boolean> {
        return new Promise((resolve, reject) => {
            Server.connection.sendRequest(Commands.GetViperFileEndings).then((endings: string[]) => {
                this.viperFileEndings = endings;
                resolve(true);
            }, err => {
                Log.error("GetViperFileEndings request was rejected by the client: " + err);
            });
        });
    }

    static isViperSourceFile(uri: string, firstTry: boolean = true): Promise<boolean> {
        return new Promise((resolve, reject) => {
            if (!this.viperFileEndings) {
                if (firstTry) {
                    Log.log("Refresh the viper file endings.", LogLevel.Debug);
                    this.refreshEndings().then(() => {
                        this.isViperSourceFile(uri, false).then(success => {
                            resolve(success)
                        });
                    })
                } else {
                    resolve(false);
                }
            } else {
                resolve(this.viperFileEndings.some(globPattern => {
                    let regex = globToRexep(globPattern);
                    return regex.test(uri);
                }));
            }
        });
    }

    static showHeap(task: VerificationTask, clientIndex: number, isHeapNeeded: boolean) {
        Server.connection.sendRequest(Commands.HeapGraph, task.getHeapGraphDescription(clientIndex, isHeapNeeded));
    }

    //Communication requests and notifications sent to language client
    static sendStateChangeNotification(params: StateChangeParams, task?: VerificationTask) {
        if (task) {
            task.state = params.newState;
        }
        this.connection.sendNotification(Commands.StateChange, params);
    }
    static sendBackendReadyNotification(params: BackendReadyParams) {
        this.connection.sendNotification(Commands.BackendReady, params);
    }
    static sendStopDebuggingNotification() {
        this.connection.sendNotification(Commands.StopDebugging);
    }
    // static sendBackendChangeNotification(name: string) {
    //     this.connection.sendNotification(Commands.BackendChange, name);
    // }
    static sendSettingsCheckedNotification(errors: SettingsCheckedParams) {
        this.connection.sendNotification(Commands.SettingsChecked, errors);
    }
    static sendDiagnostics(params: PublishDiagnosticsParams) {
        this.connection.sendDiagnostics(params);
    }
    static sendStepsAsDecorationOptions(decorations: StepsAsDecorationOptionsResult) {
        Log.log("Update the decoration options (" + decorations.decorationOptions.length + ")", LogLevel.Debug);
        this.connection.sendNotification(Commands.StepsAsDecorationOptions, decorations);
    }
    static sendVerificationNotStartedNotification(uri: string) {
        this.connection.sendNotification(Commands.VerificationNotStarted, uri);
    }
    static sendFileOpenedNotification(uri: string) {
        this.connection.sendNotification(Commands.FileOpened, uri);
    }
    static sendFileClosedNotification(uri: string) {
        this.connection.sendNotification(Commands.FileClosed, uri);
    }

    static sendLogMessage(command: string, params: LogParams) {
        this.connection.sendNotification(command, params);
    }

    static sendProgressMessage(params: ProgressParams) {
        this.connection.sendNotification(Commands.Progress, params);
    }

    static sendStartBackendMessage(backend: string, forceRestart: boolean, isViperServer: boolean) {
        this.connection.sendNotification(Commands.StartBackend, { backend: backend, forceRestart: forceRestart, isViperServer: isViperServer });
    }

    static containsNumber(s: string): boolean {
        if (!s || s.length == 0) return false;
        let pattern = new RegExp(/(\d+)\.(\d+)?/g);
        let match = pattern.exec(s);
        return (match && match[1] && match[2]) ? true : false;
    }

    //regex helper methods
    static extractNumber(s: string): number {
        try {
            let match = /^.*?(\d+)([\.,](\d+))?.*$/.exec(s);
            if (match && match[1] && match[3]) {
                return Number.parseFloat(match[1] + "." + match[3]);
            } else if (match && match[1]) {
                return Number.parseInt(match[1]);
            }
            Log.error(`Error extracting number from  "${s}"`);
            return 0;
        } catch (e) {
            Log.error(`Error extracting number from  "${s}": ${e}`);
        }
    }

    public static extractPosition(s: string): { before: string, pos: Position, range: Range, after: string } {
        let before = "";
        let after = "";
        if (!s) return { before: before, pos: null, range: null, after: after };
        let pos: Position;
        let range: Range;
        try {
            if (s) {

                //parse position:
                let regex = /^(.*?)(\(?[^ ]*?@(\d+)\.(\d+)\)?|(\d+):(\d+)|<un.*>):?(.*)$/.exec(s);
                if (regex && regex[3] && regex[4]) {
                    //subtract 1 to confirm with VS Codes 0-based numbering
                    let lineNr = Math.max(0, +regex[3] - 1);
                    let charNr = Math.max(0, +regex[4] - 1);
                    pos = { line: lineNr, character: charNr };
                }
                else if (regex && regex[5] && regex[6]) {
                    //subtract 1 to confirm with VS Codes 0-based numbering
                    let lineNr = Math.max(0, +regex[5] - 1);
                    let charNr = Math.max(0, +regex[6] - 1);
                    pos = { line: lineNr, character: charNr };
                }
                if (regex && regex[1]) {
                    before = regex[1].trim();
                }
                if (regex && regex[7]) {
                    after = regex[7].trim();
                }

                //parse range
                regex = /@\[(\d+)[.:](\d+)-(\d+)[.:](\d+)]/.exec(s);
                if (regex && regex[1] && regex[2] && regex[3] && regex[4]) {
                    range = {
                        start: {
                            line: Math.max(0, +regex[1] - 1),
                            character: Math.max(0, +regex[2] - 1)
                        },
                        end: {
                            line: Math.max(0, +regex[3] - 1),
                            character: Math.max(0, +regex[4] - 1)
                        }
                    }
                    if (pos) {
                        if (pos.line != range.start.line || pos.character != range.start.character) {
                            Log.log("Warning: parsed message has contradicting position information", LogLevel.Debug);
                        }
                    }
                    else {
                        pos = range.start;
                    }
                }
            }
        } catch (e) {
            Log.error("Error extracting number out of: " + s);
        }
        return { before: before, pos: pos, range: range, after: after };
    }

    public static extractRange(startString: string, endString: string) {
        let start = Server.extractPosition(startString).pos;
        let end = Server.extractPosition(endString).pos;
        //handle uncomplete positions
        if (!end && start) {
            end = start;
        } else if (!start && end) {
            start = end;
        } else if (!start && !end) {
            start = { line: 0, character: 0 };
            end = start
        }
        return { start: start, end: end };
    }

    //file system helper methods

    public static getUser(): string {
        if (Settings.isLinux) {
            return process.env["USER"];
        } else if (Settings.isMac) {
            return process.env["USER"];
        } else {
            Log.error("getUser is unimplemented for Windows")//TODO: implement
            return;
        }
    }

    public static makeSureFileExistsAndCheckForWritePermission(filePath: string, firstTry = true): Promise<any> {
        return new Promise((resolve, reject) => {
            try {
                let folder = pathHelper.dirname(filePath);
                mkdirp(folder, (err) => {
                    if (err && err.code != 'EEXIST') {
                        resolve(err.code + ": Error creating " + folder + " " + err.message);
                    } else {
                        fs.open(filePath, 'a', (err, file) => {
                            if (err) {
                                resolve(err.code + ": Error opening " + filePath + " " + err.message)
                            } else {
                                fs.close(file, err => {
                                    if (err) {
                                        resolve(err.code + ": Error closing " + filePath + " " + err.message)
                                    } else {
                                        fs.access(filePath, 2, (e) => { //fs.constants.W_OK is 2
                                            if (e) {
                                                resolve(e.code + ": Error accessing " + filePath + " " + e.message)
                                            } else {
                                                resolve(null);
                                            }
                                        });
                                    }
                                });
                            }
                        });
                    }
                });
            } catch (e) {
                resolve(e);
            }
        });
    }

    public static download(url, filePath): Promise<boolean> {
        return new Promise((resolve, reject) => {
            try {
                Log.startProgress();
                let file = fs.createWriteStream(filePath);
                let request = http.get(url, function (response) {
                    response.pipe(file);

                    //download progress 
                    // WTF, why is it a union type? No answer here: 
                    // https://nodejs.org/api/http.html#http_class_http_incomingmessage
                    let resp_head = response.headers['content-length']

                    let len = typeof resp_head === 'string'
                        ? parseInt(resp_head, 10) 
                        : parseInt(resp_head[0], 10);
                    let cur = 0;
                    response.on("data", function (chunk) {
                        cur += chunk.length;
                        Log.progress("Download Viper Tools", cur, len, LogLevel.Debug);
                    });

                    file.on('finish', function () {
                        file.close();
                        resolve(true);
                    });
                    request.on('error', function (err) {
                        Log.error("Error downloading viper tools: " + err.message);
                        fs.unlink(filePath, (e) => { 
                            Log.error(" (things got really nasty: the newly created files cannot be deleted.)");
                        });
                        resolve(false);
                    });
                });
            } catch (e) {
                Log.error("Error downloading viper tools: " + e);
            }
        });
    };

    public static extract(filePath: string): Promise<boolean> {
        return new Promise((resolve, reject) => {
            try {
                //extract files
                Log.log("Extracting files...", LogLevel.Info)
                Log.startProgress();
                let unzipper = new DecompressZip(filePath);

                unzipper.on('progress', function (fileIndex, fileCount) {
                    Log.progress("Extracting Viper Tools", fileIndex + 1, fileCount, LogLevel.Debug);
                });

                unzipper.on('error', function (e) {
                    if (e.code && e.code == 'ENOENT') {
                        Log.error("Error updating the Viper Tools, missing create file permission in the viper tools directory: " + e);
                    } else if (e.code && e.code == 'EACCES') {
                        Log.error("Error extracting " + filePath + ": " + e + " | " + e.message);
                    } else {
                        Log.error("Error extracting " + filePath + ": " + e);
                    }
                    resolve(false);
                });

                unzipper.on('extract', function (log) {
                    resolve(true);
                });

                unzipper.extract({
                    path: pathHelper.dirname(filePath),
                    filter: function (file) {
                        return file.type !== "SymbolicLink";
                    }
                });
            } catch (e) {
                Log.error("Error extracting viper tools: " + e);
                resolve(false);
            }
        });
    }

    public static getParentDir(fileOrFolderPath: string): string {
        if (!fileOrFolderPath) return null
        let obj = pathHelper.parse(fileOrFolderPath)
        if (obj.base) {
            return obj.dir
        }
        let folderPath = obj.dir
        let match = folderPath.match(/(^.*)[\/\\].+$/); //the regex retrieves the parent directory
        if (match) {
            if (match[1] == fileOrFolderPath) {
                Log.error("getParentDir has a fixpoint at " + fileOrFolderPath)
                return null
            }
            return match[1]
        }
        else {
            return null
        }
    }

    public static updateViperTools(askForPermission: boolean) {
        try {
            // Check Java installation
            Settings.getJavaPath()
                .then(javaPath => Log.log(`Java home found: ${javaPath}.`, LogLevel.Verbose))
                .catch(err => Log.hint(`Error while checking Java installation: ${err}.`));

            if (!Settings.upToDate()) {
                Log.hint("The settings are not up to date, refresh them before updating the Viper Tools. ", true)
                Server.connection.sendNotification(Commands.ViperUpdateComplete, false)  // update failed
                return
            }

            Log.log("Updating Viper Tools ...", LogLevel.Default)
            let url = <string>Settings.settings.preferences.viperToolsProvider
            // Extract the expected file's name
            let filename = url.split(/[\\\/]/).pop()

            // Check access to download location
            let dir = <string>Settings.settings.paths.viperToolsPath
            let viperToolsPath = pathHelper.join(dir, filename)

            const prepareFolderPromise = Server.confirmViperToolsUpdate()
                .then(() => Server.rmViperToolsDir(dir))
                .then(() => Server.makeSureFileExistsAndCheckForWritePermission(viperToolsPath))

            prepareFolderPromise.then(error => {
                if (error) {
                    throw new Error("The Viper Tools Update failed, change the ViperTools directory to a folder in which you have permission to create files. " + error)
                }
                //download Viper Tools
                Log.log("Downloading ViperTools from " + url + " ...", LogLevel.Default)
                return Server.download(url, viperToolsPath)
            }).then(success => {
                if (success) {
                    return Server.extract(viperToolsPath)
                } else {
                    throw new Error("Downloading viper tools unsuccessful.")
                }
            }).then(success => {
                if (success) {
                    Log.log("Extracting ViperTools finished " + (success ? "" : "un") + "successfully", LogLevel.Info)
                    if (success) {
                        // chmod to allow the execution of boogie and z3 files  
                        // 755 is for (read, write, execute)
                        // TODO: use async code and add error handlers
                        if (Settings.isLinux || Settings.isMac) {
                            fs.chmodSync(pathHelper.join(dir, "z3", "bin", "z3"), '755')  
                            fs.chmodSync(pathHelper.join(dir, "boogie", "Binaries", "Boogie"), '755')
                        }
                        // delete the archive
                        fs.unlink(viperToolsPath, (err) => {
                            if (err) {
                                Log.error("Error deleting archive after ViperToolsUpdate: " + err)
                            }
                            Log.log("ViperTools Update completed", LogLevel.Default)
                            Server.connection.sendNotification(Commands.ViperUpdateComplete, true)  //success
                        })
                        // trigger a restart of the backend
                        Settings.initiateBackendRestartIfNeeded(null, null, true)
                    }
                } else {
                    throw new Error("Extracting viper tools unsuccessful.")
                }
            }).catch(e => {
                Log.error(e)
                Server.connection.sendNotification(Commands.ViperUpdateComplete, false)  //update failed
            })
        } catch (e) {
            Log.error("Error installing Viper tools: " + e)
            Server.connection.sendNotification(Commands.ViperUpdateComplete, false)  //update failed
        }
    }

    private static confirmViperToolsUpdate(): Promise<void> {
        // note that `confirm` is unfortunately not available in the server environment.
        // as a hack to make users aware of Viper IDE installing something, we use execute "echo" as sudo.
        // after switching to the LSP frontend of ViperServer, the update routine will be triggered by the client and thus
        // we will have access to the vscode API and can show a proper confirmation dialog.
        const command = "echo"
        return Common.sudoExecuter(command, "ViperTools Installer")
            .catch(() => {
                // rethrow error but with a better message:
                throw `Administrator permissions have not been granted to Viper IDE for installing Viper tools.`;
            });
    }

    private static rmViperToolsDir(path: string): Promise<void> {
        let command: string
        if (Settings.isWin) {
            command = `if exist "${path}"\ ( rmdir /s /q  + "${path}" )`
        } else {
            command = `rm -fr '${path}'`
        }
        return new Promise(resolve => {
            Common.executor(command, resolve)
        }) 
    }
}
