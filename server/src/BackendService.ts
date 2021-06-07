/**
  * This Source Code Form is subject to the terms of the Mozilla Public
  * License, v. 2.0. If a copy of the MPL was not distributed with this
  * file, You can obtain one at http://mozilla.org/MPL/2.0/.
  *
  * Copyright (c) 2011-2019 ETH Zurich.
  */
 
'use strict';

import * as child_process from 'child_process'
import { Log } from './Log'
import { Settings } from './Settings'
import { Stage, Backend, VerificationState, LogLevel } from './ViperProtocol'
import { Server } from './ServerClass';

export abstract class BackendService {
    backendProcess: child_process.ChildProcess;
    instanceCount: number = 0;
    isSessionRunning: boolean = false;
    backendServerPid: number;
    
    ngSessionFinished = () => { };

    private _ready: boolean = false;

    protected timeout;
    protected engine: string;

    public isViperServerService: boolean;

    public isReady(): boolean {
        return this._ready;
    }
    public abstract start(backend: Backend): Promise<boolean>;
    public abstract stop(): Promise<boolean>;
    public abstract stopVerification(secondTry?: boolean): Promise<boolean>;
    protected isBackendCompatible(backend: Backend): boolean {
        return Server.backend.engine.toLowerCase() != this.engine.toLowerCase();
    }

    public swapBackend(newBackend: Backend) {
        Log.error("The current backend service does not support swaping backends, stop the backend instead.")
        this.stop();
    }

    public kill(): Promise<boolean> {
        return this.stop();
    }

    public startStageProcess(fileToVerify: string, stage: Stage, onData, onError, onClose) {
        try {
            Log.log("Start Stage Process", LogLevel.LowLevelDebug);

            if (this.isBackendCompatible(Server.backend)) {
                Log.error("The engine required by the backend (" + Server.backend.engine + ") does not correspond to the running engine: " + this.engine)
            }

            let command = this.getStageCommand(fileToVerify, stage);

            //this.verifyProcess = 
            this.startVerifyProcess(command, fileToVerify, onData, onError, onClose);

        } catch (e) {
            Log.error("Error starting stage process: " + e);
        }
    }
    protected abstract startVerifyProcess(command: string, file: string, onData, onError, onClose);

    protected getServerPid(): Promise<number> {
        Log.log("Determining the backend server PID", LogLevel.LowLevelDebug);
        if (!this.backendProcess) {
            if ( Settings.settings.viperServerSettings.viperServerPolicy === "attach" ) {
                let url = Settings.settings.viperServerSettings.viperServerAddress + ":" + Settings.settings.viperServerSettings.viperServerPort
                return Promise.reject("The backendProcess should be set before determining its PID " + 
                                      "(you have Settings.settings.viperServerSettings.viperServerPolicy set to 'attach'; " + 
                                      "is the server actually running on " + url + " ?)");
            } else {
                return Promise.reject("The backendProcess should be set before determining its PID");
            }
        }

        return new Promise((resolve, reject) => {
            try {
                let command: string;
                if (Settings.isWin) {
                    command = 'wmic process where "parentprocessId=' + this.backendProcess.pid + ' and name=\'java.exe\'" get ProcessId';
                } else if (Settings.isLinux) {
                    command = 'pgrep -P ' + this.backendProcess.pid;
                } else {
                    //No need to get the childProcess
                    resolve(this.backendProcess.pid);
                    return;
                }
                Log.log("Getting backend server PID: " + command, LogLevel.Debug)
                child_process.exec(command, (strerr, stdout, stderr) => {
                    let regex = /.*?(\d+).*/.exec(stdout);
                    if (regex != null && regex[1]) {
                        resolve(parseInt(regex[1]));
                    } else {
                        Log.log("Error getting backend server Pid", LogLevel.LowLevelDebug);
                        reject("");
                    }
                });
            } catch (e) {
                reject("Error determining the backend server PID: " + e);
            }
        });
    }

    protected startTimeout(instanceCount: number) {
        let timeout = Settings.settings.viperServerSettings.timeout
        if (timeout) {
            this.timeout = setTimeout(() => {
                if (!this.isReady() && this.instanceCount == instanceCount) {
                    Log.hint("The backend server startup timed out after " + timeout + "ms, make sure the files in " + Settings.expandViperToolsPath("$ViperTools$/backends/") + " contain no conflicting jars");
                    this.kill();
                }
            }, timeout);
        }
    }

    public setReady(backend: Backend) {
        this._ready = true;
        Server.backend = backend;
        Server.startingOrRestarting = false;
        Log.log("The backend is ready for verification", LogLevel.Info);
        Server.sendBackendReadyNotification({
            name: Server.backend.name,
            restarted: Settings.settings.preferences.autoVerifyAfterBackendChange,
            isViperServer: Server.backendService.isViperServerService
        });

        this.getServerPid().then(pid => {
            this.backendServerPid = pid;
            Log.log("The backend server pid is " + pid, LogLevel.LowLevelDebug);
        }).catch(e => {
            Log.error(e);
        });
    }

    private getViperBackendClassName(stage: Stage): string {
        switch ( Server.backend.type ) {
            case "silicon": return "silicon"
            case "carbon": return "carbon"
            case "other": return stage.mainMethod
            default: throw new Error('Invalid verification backend value. Possible values are silicon|carbon|other but found `' + Server.backend + '`')
        }
    }

    protected getStageCommand(fileToVerify: string, stage: Stage): string {
        let args = this.getViperBackendClassName(stage) + " " + stage.customArguments;
        let command = Settings.expandCustomArguments(args, stage, fileToVerify, Server.backend);
        Log.log(command, LogLevel.Debug);
        return command;
    }

    public setStopping() {
        Log.log("Set Stopping... ", LogLevel.Debug);
        this._ready = false;
        Server.startingOrRestarting = false;
        Server.sendStateChangeNotification({ newState: VerificationState.Stopping });
    }

    public setStopped() {
        Log.log("Set Stopped. ", LogLevel.Debug);
        this._ready = false;
        Server.startingOrRestarting = false;
        Server.sendStateChangeNotification({ newState: VerificationState.Stopped });
    }
}
