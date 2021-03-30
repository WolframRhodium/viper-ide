/**
  * This Source Code Form is subject to the terms of the Mozilla Public
  * License, v. 2.0. If a copy of the MPL was not distributed with this
  * file, You can obtain one at http://mozilla.org/MPL/2.0/.
  *
  * Copyright (c) 2011-2019 ETH Zurich.
  */
 
'use strict';
import { LanguageClient, LanguageClientOptions, ServerOptions, TransportKind, StreamInfo } from 'vscode-languageclient';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as net from 'net';
import * as child_process from "child_process";
import { Commands, LogLevel, ViperSettings } from './ViperProtocol';
import { Log } from './Log';
import { ViperFileState } from './ViperFileState';
import Uri from 'vscode-uri';
import { Helper } from './Helper';
import { StateVisualizer } from './StateVisualizer';
import { Color, StatusBar } from './StatusBar';
import { VerificationController, Task } from './VerificationController';
import { UnitTestCallback } from './test/extension.test';
import { ViperApi } from './ViperApi';

export class State {
    public static client: LanguageClient;
    public static context: vscode.ExtensionContext;
    public static instance: State;

    public static viperFiles: Map<string, ViperFileState> = new Map<string, ViperFileState>();
    public static isBackendReady: boolean;
    public static isDebugging: boolean;
    public static isVerifying: boolean;
    private static languageServerDisposable;
    public static isWin = /^win/.test(process.platform);
    public static isLinux = /^linux/.test(process.platform);
    public static isMac = /^darwin/.test(process.platform);
    private static lastActiveFileUri: string;
    public static verificationController: VerificationController;

    public static activeBackend: string;
    public static isActiveViperEngine: boolean = true;

    public static unitTest: UnitTestCallback;

    // Set to false for debuggin. Should eventually be changed back to true.
    public static autoVerify: boolean = false;

    //status bar
    public static statusBarItem: StatusBar;
    public static statusBarProgress: StatusBar;
    public static backendStatusBar: StatusBar;
    public static abortButton: StatusBar;
    
    public static diagnosticCollection: vscode.DiagnosticCollection;

    public static checkedSettings:ViperSettings;

    public static viperApi: ViperApi;

    public static getTimeoutOfActiveBackend():number{
        if (!this.checkedSettings) {
            //TODO Make this a settable parameter.
            return 10000;
        }else{
            let backend = this.checkedSettings.verificationBackends.find(b => b.name == this.activeBackend);
            return backend.timeout;
        }
    }

    public static addToWorklist(task: Task) {
        this.verificationController.addToWorklist(task);
    }

    public static initializeStatusBar(context) {
        this.statusBarItem = new StatusBar(10, context);
        this.statusBarItem.update("Hello from Viper", Color.READY).show();

        this.abortButton = new StatusBar(11, context);
        this.abortButton.setCommand("viper.stopVerification");
        this.abortButton.update("$(x) Stop", Color.WARNING);
        this.statusBarProgress = new StatusBar(9, context);
        this.hideProgress();

        this.backendStatusBar = new StatusBar(12, context);
        this.backendStatusBar.show();

        
        this.diagnosticCollection = vscode.languages.createDiagnosticCollection();
    }

    public static hideProgress(){
        this.abortButton.hide();
        this.statusBarProgress.hide().updateProgressBar(0);
    }

    public static setLastActiveFile(uri: Uri | string | vscode.Uri, editor: vscode.TextEditor): ViperFileState {
        this.lastActiveFileUri = uri.toString();
        let lastActiveFile = this.getFileState(uri);
        if (lastActiveFile) {
            lastActiveFile.setEditor(editor);
        }
        return lastActiveFile;
    }

    public static getLastActiveFile(): ViperFileState {
        if (this.lastActiveFileUri) {
            return this.getFileState(this.lastActiveFileUri);
        } else {
            Log.log("WARNING, No file uri of the last active file.", LogLevel.Info)
            return null;
        }
    }

    public static resetViperFiles() {
        Log.log("Reset all viper files", LogLevel.Info);
        this.viperFiles.forEach(element => {
            element.changed = true;
            element.verified = false;
            element.verifying = false;
            element.decorationsShown = false;
            element.stateVisualizer.completeReset();
        });
    }

    public static reset() {
        this.isBackendReady = false;
        this.isDebugging = false;
        this.isVerifying = false;
        this.viperFiles = new Map<string, ViperFileState>();
    }

    public static checkBackendReady(prefix: string) {
        if (!this.isBackendReady) {
            Log.log(prefix + "Backend is not ready.", LogLevel.Debug);
        }
        return this.isBackendReady;
    }

    public static getVisualizer(uri: Uri | string | vscode.Uri): StateVisualizer {
        let fileState = this.getFileState(uri);
        return fileState ? fileState.stateVisualizer : null;
    }

    // retrieves the requested file, creating it when needed
    public static getFileState(uri: Uri | string | vscode.Uri): ViperFileState {
        if (!uri) return null;
        let uriObject: vscode.Uri = Helper.uriToObject(uri);
        let uriString: string = Helper.uriToString(uri);

        if (!Helper.isViperSourceFile(uriString)) {
            return null;
        }
        let result: ViperFileState;
        if (!State.viperFiles.has(uriString)) {
            result = new ViperFileState(uriObject)
            State.viperFiles.set(uriString, result);
        } else {
            result = State.viperFiles.get(uriString);
        }
        return result;
    }

    public static startLanguageServer(context: vscode.ExtensionContext, fileSystemWatcher: vscode.FileSystemWatcher, brk: boolean) {
        function startViperServer(): Promise<StreamInfo> {
            return new Promise((resolve, reject) => {
                let server = net.createServer((socket) => {
                    console.log("Creating server");
                    resolve({
                        reader: socket,
                        writer: socket
                    });
        
                    socket.on('end', () => console.log("Disconnected"));
                }).on('error', (err) => {
                    // handle errors here
                    throw err;
                });
                // grab a random port.
                server.listen(() => {
                    // Start the child java process
                    // TODO: Replace null with path to a viper.jar here:
                    let serverJar = null
                    let args = [
                        '-cp',
                        serverJar,
                        'LanguageServerRunner',
                        (server.address() as net.AddressInfo).port.toString()
                    ]
        
                    let process = child_process.spawn("java", args);
    
                    // Send raw output to a file
                    let logFile = context.asAbsolutePath('languageServerExample.log');
                    let logStream = fs.createWriteStream(logFile, { flags: 'w' });
        
                    process.stdout.pipe(logStream);
                    process.stderr.pipe(logStream);
        
                    console.log(`Storing log in '${logFile}'`);
                });
            });
        }
        
        // Options to control the language client
        let clientOptions: LanguageClientOptions = {
            // Register the server for plain text documents
            documentSelector: ['viper'],
            synchronize: {
                // Synchronize the setting section 'viperSettings' to the server
                configurationSection: 'viperSettings',
                // Notify the server about file changes to .sil or .vpr files contain in the workspace
                fileEvents: fileSystemWatcher
            }
        }

        State.client = new LanguageClient('languageServer', 'Language Server', startViperServer, clientOptions, brk);

        Log.log("Start Language Server", LogLevel.Info);
        // Create the language client and start the client.
        this.languageServerDisposable = State.client.start();

        if (!State.client || !this.languageServerDisposable) {
            Log.error("LanguageClient is undefined");
        }
    }

    public static dispose(): Promise<any> {
        try {
            return new Promise((resolve, reject) => {
                Log.log("Initiating language server shutdown.", LogLevel.Info);
                State.client.stop() // initiate's LSP's termination sequence
            });
        } catch (e) {
            Log.error("Error disposing state: " + e);
        }
    }

    public static checkOperatingSystem() {
        if ((this.isWin ? 1 : 0) + (this.isMac ? 1 : 0) + (this.isLinux ? 1 : 0) != 1) {
            Log.error("Cannot detect OS")
            return;
        }
        if (this.isWin) {
            Log.log("OS: Windows", LogLevel.Debug);
        }
        else if (this.isMac) {
            Log.log("OS: OsX", LogLevel.Debug);
        }
        else if (this.isLinux) {
            Log.log("OS: Linux", LogLevel.Debug);
        }
    }
}
