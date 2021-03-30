/**
  * This Source Code Form is subject to the terms of the Mozilla Public
  * License, v. 2.0. If a copy of the MPL was not distributed with this
  * file, You can obtain one at http://mozilla.org/MPL/2.0/.
  *
  * Copyright (c) 2011-2020 ETH Zurich.
  */
 
'use strict';

import { Log } from './Log';
import { GetExecutionTraceParams, ExecutionTrace, TimingInfo, ShowHeapParams, StepsAsDecorationOptionsResult, MyProtocolDecorationOptions, StateColors, Position, HeapGraph, Commands, LogLevel } from './ViperProtocol';
import * as fs from 'fs';
import child_process = require('child_process');
import { HeapProvider } from './HeapProvider';
import * as vscode from 'vscode';
import { Helper } from './Helper';
import { State } from './ExtensionState';
import { ViperFileState } from './ViperFileState';
import * as path from 'path';

export interface MyDecorationOptions extends vscode.DecorationOptions {
    numberToDisplay: number;
    originalPosition: Position;
    depth: number;
    index: number;
    parent: number;
    methodIndex: number;
    isErrorState: boolean;
}

export class StateVisualizer {

    static showStates: boolean = false;

    collapsedSymbol = "⚫";

    viperFile: ViperFileState;

    graphvizProcess: child_process.ChildProcess;
    provider: HeapProvider;
    previewUri = vscode.Uri.parse('viper-preview:State Visualization');

    decoration: vscode.TextEditorDecorationType;
    decorationOptions: MyDecorationOptions[];
    readyToDebug: boolean = false;
    decorationOptionsByPosition: Map<string, MyDecorationOptions>;
    globalInfo: string;
    uri: vscode.Uri;

    currentState: number;
    previousState: number;
    currentDepth: number;
    debuggedMethodName: string;
    currentOffset: number;

    nextHeapIndex = 0;

    private removingSpecialChars = false;
    private addingSpecialChars = false;
    private addingTimingInformation = false;

    public initialize(viperFile: ViperFileState) {
        this.viperFile = viperFile;
        this.uri = viperFile.uri;
        this.registerTextDocumentProvider();
    }

    registerTextDocumentProvider() {
        this.provider = new HeapProvider();
        this.provider.stateVisualizer = this;
        let registration = vscode.workspace.registerTextDocumentContentProvider('viper-preview', this.provider);
    }

    public reset() {
        this.nextHeapIndex = 0;
        this.provider.resetState();
        this.currentState = -1;
        this.previousState = -1;
    }

    public completeReset() {
        this.reset();
        this.decorationOptions = [];
        this.readyToDebug = false;
        this.doHideDecorations();
        this.decorationOptionsByPosition = new Map<string, MyDecorationOptions>();
    }

    //needed to cast the decorations 
    private toDecorationOptions(decorations: MyProtocolDecorationOptions[]): MyDecorationOptions[] {
        let result: MyDecorationOptions[] = [];
        decorations.forEach(d => {
            result.push({
                numberToDisplay: d.numberToDisplay,
                hoverMessage: d.hoverMessage,
                range: new vscode.Range(new vscode.Position(d.range.start.line, d.range.start.character), new vscode.Position(d.range.end.line, d.range.end.character)),
                renderOptions: {
                    before: {
                        contentText: d.renderOptions.before.contentText,
                        color: d.renderOptions.before.color
                    }
                },
                originalPosition: new vscode.Position(d.originalPosition.line, d.originalPosition.character),
                depth: d.depth,
                index: d.index,
                parent: d.parent,
                methodIndex: d.methodIndex,
                isErrorState: d.isErrorState
            })
        });
        return result;
    }

    storeNewStates(decorations: StepsAsDecorationOptionsResult) {
        Log.log("Store new States", LogLevel.Debug);

        if (!decorations) {
            Log.error("invalid arguments for storeNewStates");
            return;
        }

        this.previousState = -1;
        this.decorationOptions = this.toDecorationOptions(decorations.decorationOptions);
        this.globalInfo = decorations.globalInfo;
        this.decorationOptionsByPosition = new Map<string, MyDecorationOptions>();
        this.completeDecorationOptions();
        this.readyToDebug = this.decorationOptions.length > 0;
    }

    public createAndShowHeap(heapGraph: HeapGraph, index: number) {
        if (!heapGraph.heap) {
            Log.error("Error creating heap description: no heap");
            return;
        }

        if (heapGraph.fileUri != this.uri.toString()) {
            Log.error("Uri mismatch in StateVisualizer: " + this.uri.toString() + " expected, " + heapGraph.fileUri + " found.")
            return;
        }

        this.provider.setState(heapGraph, index);

        this.showHeapGraph();

        //NO LONGER NEEDED: since we use viz.js now:
        // this.generateSvg(heapGraph.heap, Log.dotFilePath(index, false), Log.svgFilePath(index, false), () => {
        //     this.generateSvg(heapGraph.oldHeap, Log.dotFilePath(index, true), Log.svgFilePath(index, true), () => {
        //         this.generateSvg(heapGraph.partialExecutionTree, Log.getPartialExecutionTreeDotPath(index), Log.getPartialExecutionTreeSvgPath(index), () => {
        //             this.showHeapGraph();
        //         });
        //     });
        // });
    }

    public pushState(heapGraph: HeapGraph) {
        if (Helper.getConfiguration("advancedFeatures").compareStates === true) {
            //update heap preview
            let currHeapIndex = this.nextHeapIndex
            this.nextHeapIndex = 1 - this.nextHeapIndex;
            this.createAndShowHeap(heapGraph, currHeapIndex);
            //only update previous state, if not already updated
            if (this.currentState != heapGraph.state) {
                this.previousState = this.currentState;
                this.currentState = heapGraph.state;
            }
            //highligh states
            this.markStateSelection(heapGraph.methodName, heapGraph.position);
        } else {
            this.setState(heapGraph);
        }
    }

    public setState(heapGraph: HeapGraph) {
        let currentIndex = 0;
        if (Helper.getConfiguration("advancedFeatures").compareStates === true) {
            currentIndex = this.provider.nofHeapGraphs() > 0 ? 1 : 0;
        }
        if (this.currentState != heapGraph.state) {
            this.previousState = this.currentState;
            this.currentState = heapGraph.state;
        }

        this.createAndShowHeap(heapGraph, currentIndex);
        this.nextHeapIndex = 1;

        let currentHeap = this.provider.getCurrentHeap();
        let previousHeap = this.provider.getPreviousHeap();
        this.previousState = previousHeap ? previousHeap.state : -1;
        this.markStateSelection(currentHeap.methodName, currentHeap.position);
    }

    public focusOnState(heapGraph: HeapGraph) {
        this.reset();
        this.nextHeapIndex = 1;
        this.createAndShowHeap(heapGraph, 0);
        this.currentState = heapGraph.state;
        this.previousState = -1;
        this.markStateSelection(heapGraph.methodName, heapGraph.position);
        this.requestState(heapGraph.state, false);
    }

    private showHeapGraph() {
        this.provider.update(this.previewUri);
        //Log.log("Show heap graph", LogLevel.Debug);
        vscode.commands.executeCommand('vscode.previewHtml', this.previewUri, vscode.ViewColumn.Two).then((success) => { }, (reason) => {
            Log.error("HTML Preview error: " + reason);
        });
    }

    completeDecorationOptions() {
        for (var i = 0; i < this.decorationOptions.length; i++) {
            let option = this.decorationOptions[i];
            //fill in decorationOptionsOrderedByState
            let key = this.vscodePosToKey(option.range.start);
            if (this.decorationOptionsByPosition.has(key)) {
                Log.error("multiple decoration options with the same position detected at: " + key);
            }
            this.decorationOptionsByPosition.set(key, option);
        }
    }

    vscodePosToKey(pos: vscode.Position): string {
        return pos.line + ":" + pos.character;
    }
    posToKey(line: number, character: number): string {
        return line + ":" + character;
    }

    private collapseOutsideMethod(option: MyDecorationOptions, currentMethodIdx: number) {
        if (option.methodIndex == currentMethodIdx)
            option.renderOptions.before.contentText = this.getLabel(option);
        else
            option.renderOptions.before.contentText = this.collapsedSymbol;

    }
    private getLabel(option: MyDecorationOptions) {
        if (!option) return "()"
        return `(${option.numberToDisplay})`;
    }

    private expand(option: MyDecorationOptions) {
        option.renderOptions.before.contentText = this.getLabel(option);
    }

    private collapse(option: MyDecorationOptions) {
        option.renderOptions.before.contentText = this.collapsedSymbol;
    }

    private hide(option: MyDecorationOptions) {
        option.renderOptions.before.contentText = "";
    }

    private color(option: MyDecorationOptions, color: string, darkGraphs: boolean) {
        let isOldCurrentState = StateColors.currentState(darkGraphs) == option.renderOptions.before.color;
        let isOldPreviousState = StateColors.previousState(darkGraphs) == option.renderOptions.before.color;
        let isOldErrorState = StateColors.errorState(darkGraphs) == option.renderOptions.before.color;
        let isNewCurrentState = StateColors.currentState(darkGraphs) == color;
        let isNewPreviousState = StateColors.previousState(darkGraphs) == color;
        let isNewUninterestingState = StateColors.uninterestingState(darkGraphs) == color;
        let isNewInterestingState = StateColors.interestingState(darkGraphs) == color;
        let isNewErrorState = StateColors.errorState(darkGraphs) == color;
        if (isNewUninterestingState
            || isNewCurrentState
            || (!isOldCurrentState && isNewPreviousState)
            || (!isOldCurrentState && !isOldPreviousState && isNewErrorState)
            || (!isOldCurrentState && !isOldPreviousState && !isOldErrorState && isNewInterestingState)) {
            option.renderOptions.before.color = color;
        }
    }

    markStateSelection(debuggedMethodName: string, pos: Position) {
        if (StateVisualizer.showStates && this.decorationOptions) {
            //state should be visualized
            if (this.currentState >= 0 && this.currentState < this.decorationOptions.length) {
                let selectedOption = this.decorationOptions[this.currentState];

                //this.selectedPosition = this.decorationOptionsOrderedByState[selectedState].range.start;
                this.currentDepth = selectedOption.depth;
                let currentMethodIdx = selectedOption.methodIndex;
                this.debuggedMethodName = debuggedMethodName

                let darkGraphs = <boolean>Helper.getConfiguration("advancedFeatures").darkGraphs === true;

                let isCurrentStateErrorState = false;
                //color labels
                for (var i = 0; i < this.decorationOptions.length; i++) {
                    let option = this.decorationOptions[i];
                    let errorStateFound = false;

                    this.hide(option);
                    this.color(option, StateColors.uninterestingState(darkGraphs), darkGraphs);

                    if (option.index == this.currentState) {
                        //if it's the current step -> red
                        this.expand(option);
                        this.color(option, StateColors.currentState(darkGraphs), darkGraphs);
                        isCurrentStateErrorState = option.isErrorState;
                        continue;
                    } else if (option.index == this.previousState) {
                        this.expand(option);
                        this.color(option, StateColors.previousState(darkGraphs), darkGraphs);
                        continue;
                    } else if (option.isErrorState /*&& option.methodIndex === currentMethodIdx*/) {
                        this.collapse(option);
                        this.color(option, StateColors.errorState(darkGraphs), darkGraphs);
                        errorStateFound = true;
                    }
                }
                if (StateVisualizer.showStates) {
                    //mark execution trace that led to the current state
                    Log.log("Request Execution Trace", LogLevel.Info);
                    let simpleMode = Helper.getConfiguration("advancedFeatures").simpleMode;
                    if (!this.executionTrace || simpleMode !== true || (simpleMode === true && isCurrentStateErrorState)) {
                        let params: GetExecutionTraceParams = { uri: this.uri.toString(), clientState: this.currentState };
                        State.client.sendRequest(Commands.GetExecutionTrace, params).then((trace: ExecutionTrace[]) => {
                            this.executionTrace = trace;
                            this.markExecutionTrace(darkGraphs);
                        });
                    } else {
                        this.markExecutionTrace(darkGraphs);
                    }
                }
            }
        }
    }

    private markExecutionTrace(darkGraphs: boolean) {
        Log.log("Mark Execution Trace", LogLevel.Debug);
        this.executionTrace.forEach(element => {
            let option = this.decorationOptions[element.state];
            if (element.state != this.previousState && element.state != this.currentState) {
                if (element.showNumber) {
                    this.expand(option);
                } else {
                    this.collapse(option);
                }
                this.color(option, element.color, darkGraphs);
            }
        });
        this.showDecorations();
    }

    private executionTrace: ExecutionTrace[];

    //request the heap graph of state from the language server
    private requestState(state: number, isHeapNeeded: boolean) {
        Log.log("Request showing the heap of state " + state, LogLevel.Debug);
        let params: ShowHeapParams = {
            uri: this.uri.toString(),
            clientIndex: state,
            isHeapNeeded: isHeapNeeded
        }
        State.client.sendRequest(Commands.ShowHeap, params);
    }

    //handle both selection change, or debugger movement notification
    showStateSelection(pos: { line: number, character: number }) {
        if (StateVisualizer.showStates && this.decorationOptionsByPosition) {
            let key = this.posToKey(pos.line, pos.character);
            if (this.decorationOptionsByPosition.has(key)) {
                //there is a decoration at the selected position
                let decoration = this.decorationOptionsByPosition.get(key);
                let selectedState = decoration.index;

                if (Helper.getConfiguration("advancedFeatures").simpleMode === true) {
                    //Simple Mode
                    if (decoration.renderOptions.before.contentText && decoration.renderOptions.before.contentText.length > 0) {
                        //the selected element is visible and thus, lies on the execution path to the current state
                        if (this.previousState == selectedState || this.currentState == selectedState) {
                            //the shown state has been selected twice, focus on current state
                            this.focusOnState(this.provider.getCurrentHeap());
                        } else {
                            this.requestState(selectedState, true);
                        }
                    }
                } else {
                    //Advanced Mode
                    if (this.currentState != selectedState) {
                        this.previousState = this.currentState;
                        this.currentState = selectedState
                        this.requestState(this.currentState, true);
                    } else {
                        //focus on current state if it is selected twice in a row
                        this.focusOnState(this.provider.getCurrentHeap());
                    }
                }
            }
        }
    }

    showAllDecorations() {
        try {
            if (StateVisualizer.showStates && this.decorationOptions) {
                Log.log("Showing all state markers", LogLevel.Info)
                let darkGraphs = <boolean>Helper.getConfiguration("advancedFeatures").darkGraphs === true;
                for (var i = 0; i < this.decorationOptions.length; i++) {
                    let option = this.decorationOptions[i];

                    //expand all states
                    this.expand(option);
                    if (option.index == this.currentState) {
                        this.color(option, StateColors.currentState(darkGraphs), darkGraphs);
                    } else if (option.index == this.previousState) {
                        this.color(option, StateColors.previousState(darkGraphs), darkGraphs);
                        continue;
                    } else {
                        this.color(option, StateColors.interestingState(darkGraphs), darkGraphs);
                    }
                }
                this.showDecorations();
            }
        } catch (e) {
            Log.error("Error showing all states: " + e)
        }
    }

    hideDecorations() {
        if (this.decoration) {
            Log.log("Hide decorations", LogLevel.Debug);
            this.doHideDecorations();
        }
        this.viperFile.decorationsShown = false;
    }

    private doHideDecorations() {
        if (this.decoration) {
            this.decoration.dispose();
        }
    }

    showDecorations() {
        let editor = this.viperFile.editor;
        if (StateVisualizer.showStates && this.decorationOptions) {
            if (editor.document.uri.toString() !== this.uri.toString()) {
                Log.log("Don't show states file mismatch", LogLevel.Debug);
                return;
            }
            this.viperFile.decorationsShown = true;
            Log.log("Show decorations", LogLevel.Debug);
            this.doHideDecorations();
            this.decoration = vscode.window.createTextEditorDecorationType({});
            if (editor) {
                editor.setDecorations(this.decoration, this.decorationOptions);
            } else {
                Log.error("cannot show decorations: no editor to show it in");
            }
        }
    }

    private timingPrefix = '//@TIMING:';

    getLastTiming(): TimingInfo {
        let uri = this.viperFile.editor.document.uri.toString();
        let viperFile: ViperFileState = State.viperFiles.get(uri);
        let timingInfo: TimingInfo;
        if (viperFile) {
            timingInfo = viperFile.timingInfo;
        }
        return timingInfo;
    }

    addTimingInformationToFileState(timingInfo: TimingInfo) {
        if (this.areSpecialCharsBeingModified("Don't add timing to file, its being modified")) return;
        try {
            let editor: vscode.TextEditor = this.viperFile.editor;
            if (Helper.getConfiguration("preferences").showProgress && this.viperFile.open && editor) {
                //strangely editor is null here, even though I just checked
                let uri = editor.document.uri.toString();
                let viperFile: ViperFileState = State.viperFiles.get(uri);
                if (viperFile) {
                    viperFile.timingInfo = timingInfo;
                }
            }
        } catch (e) {
            Log.error("Error adding timing information: " + e);
        }
    }

    //unused
    //TIMING IN FILE
    /**
     * deprecated
     */
    getLastTimingFromFile(): TimingInfo {
        let content = this.viperFile.editor.document.getText();
        let timingStart = content.indexOf(this.timingPrefix);
        let timingEnd = content.indexOf('}', timingStart) + 1;
        let timingInfo: TimingInfo;
        if (timingStart >= 0) {
            try {
                timingInfo = JSON.parse(content.substring(timingStart + this.timingPrefix.length, timingEnd));
            } catch (e) {
                Log.log("Warning: Misformed timing information: " + content.substring(timingStart + this.timingPrefix.length, timingEnd), LogLevel.Debug);
            }
        }
        return timingInfo;
    }
    addTimingInformationToFile(time: TimingInfo) {
        if (this.areSpecialCharsBeingModified("Don't add timing to file, its being modified")) return;
        try {
            let editor = this.viperFile.editor;
            if (Helper.getConfiguration("preferences").showProgress && this.viperFile.open && editor) {
                this.addingTimingInformation = true;
                let openDoc = editor.document;
                let edit = new vscode.WorkspaceEdit();
                let content = openDoc.getText();
                let timingStart = content.indexOf(this.timingPrefix)
                let timingEnd = content.indexOf('}', timingStart) + 1;
                let newTiming = this.timingPrefix + JSON.stringify(time);
                if (timingStart >= 0) {
                    if (timingEnd <= 0) {
                        timingEnd = content.length + 1;
                    }
                    //replace existing timing
                    edit.replace(openDoc.uri, new vscode.Range(openDoc.positionAt(timingStart), openDoc.positionAt(timingEnd)), newTiming);
                } else {
                    //add new timing if there is non yet
                    edit.insert(openDoc.uri, openDoc.positionAt(content.length), "\n" + newTiming);
                }
                this.viperFile.onlySpecialCharsChanged = true;
                vscode.workspace.applyEdit(edit).then(resolve => {
                    if (resolve) {
                        openDoc.save().then(() => {
                            this.addingTimingInformation = false;
                            Log.log("Timing information added to " + this.viperFile.name(), LogLevel.Debug);
                        });
                    } else {
                        this.addingTimingInformation = false;
                    }
                }, reason => {
                    Log.error("Error adding timing information: apply was rejected: " + reason)
                    this.addingTimingInformation = false;
                });
            }
        } catch (e) {
            this.addingTimingInformation = false;
            Log.error("Error adding timing information: " + e);
        }
    }

    //SPECIAL CHARACTER METHODS

    private areSpecialCharsBeingModified(s: string) {
        if (this.addingSpecialChars) {
            Log.log(s + " they are already being added to " + this.viperFile.name(), LogLevel.Debug);
            return true;
        }
        if (this.removingSpecialChars) {
            Log.log(s + " they are already being removed from " + this.viperFile.name(), LogLevel.Debug);
            return true;
        }
        return false;
    }

    addCharacterToDecorationOptionLocations(callback) {
        Log.log("Try to add special chars to " + this.viperFile.name(), LogLevel.Debug);
        if (this.areSpecialCharsBeingModified("Don't add special chars,")) return;
        if (!this.decorationOptions || this.decorationOptions.length == 0) return;
        try {
            let editor = this.viperFile.editor;
            if (StateVisualizer.showStates && editor && this.decorationOptions) {
                this.addingSpecialChars = true;
                this.viperFile.specialCharsShown = true;
                Log.log("Adding Special characters", LogLevel.Debug);
                let openDoc = editor.document;
                let edit = new vscode.WorkspaceEdit();
                this.decorationOptions.forEach((element, i) => {
                    let p = this.decorationOptions[i].originalPosition;
                    //need to create a propper vscode.Position object
                    let pos = new vscode.Position(p.line, p.character);
                    edit.insert(openDoc.uri, pos, '\u200B');
                });
                this.viperFile.onlySpecialCharsChanged = true;
                vscode.workspace.applyEdit(edit).then(resolve => {
                    if (resolve) {
                        openDoc.save().then(() => {
                            this.addingSpecialChars = false;
                            Log.log("Special chars added to file " + this.viperFile.name(), LogLevel.Debug);
                            callback();
                        });
                    } else {
                        this.addingSpecialChars = false;
                    }
                }, reason => {
                    Log.error("Error adding special chars: apply was rejected: " + reason)
                    this.addingSpecialChars = false;
                });
            }
        } catch (e) {
            this.addingSpecialChars = false;
            Log.error("Error adding special chars: " + e);
        }
    }

    public removeSpecialCharacters(callback) {
        this.removeSpecialCharacterCallbacks.push(callback);
        if (this.areSpecialCharsBeingModified("Don't remove special chars,")) return;
        try {
            if (!this.viperFile.editor || !this.viperFile.editor.document) {
                Log.error("Error removing special chars, no document to remove it from");
                return;
            }
            this.removingSpecialChars = true;
            //Log.log("Remove special characters from " + path.basename(this.uri.toString()), LogLevel.Info);
            let openDoc = this.viperFile.editor.document;
            let edit = new vscode.WorkspaceEdit();
            let content = openDoc.getText();
            let start = 0;
            let found = false;
            for (let i = 0; i < content.length; i++) {
                if (content[i] === '⦿' || content[i] === '\u200B') {
                    if (!found) {
                        found = true;
                        start = i;
                    }
                } else if (found) {
                    let range = new vscode.Range(openDoc.positionAt(start), openDoc.positionAt(i));
                    edit.delete(openDoc.uri, range);
                    found = false;
                }

            }
            if (edit.size > 0) {
                this.viperFile.onlySpecialCharsChanged = true;
                vscode.workspace.applyEdit(edit).then(resolve => {
                    if (resolve) {
                        this.viperFile.editor.document.save().then(saved => {
                            Log.log("Special Chars removed from file " + this.viperFile.name(), LogLevel.Info)
                            this.removingSpecialChars = false;
                            this.viperFile.specialCharsShown = false;
                            this.callTheRemoveSpecialCharCallbacks();
                        });
                    } else {
                        this.removingSpecialChars = false;
                    }
                }, reason => {
                    this.removingSpecialChars = false;
                    Log.error("Error removing special characters: edit was rejected: " + reason);
                });
            } else {
                this.removingSpecialChars = false;
                //Log.log("No special chars to remove", LogLevel.Debug)
                this.callTheRemoveSpecialCharCallbacks();
            }
        } catch (e) {
            this.removingSpecialChars = false;
            Log.error("Error removing special characters: " + e);
        }
    }

    private removeSpecialCharacterCallbacks: any[] = [];

    private callTheRemoveSpecialCharCallbacks() {
        while (this.removeSpecialCharacterCallbacks.length > 0) {
            let callback = this.removeSpecialCharacterCallbacks.shift();
            callback();
        }
    }

    public removeSpecialCharsFromClosedDocument(callback) {
        if (this.areSpecialCharsBeingModified("Don't remove special chars from closed file,")) return;
        try {
            this.removingSpecialChars = true;
            fs.readFile(this.uri.fsPath, (err, data) => {
                if (!err && data) {
                    let newData = data.toString();
                    if (newData.indexOf("⦿") >= 0 || newData.indexOf("\u200B") >= 0) {
                        newData = newData.replace(/[⦿\u200B]/g, "");
                        this.viperFile.onlySpecialCharsChanged = true;
                        fs.writeFileSync(this.uri.fsPath, newData);
                    }
                    Log.log("Special chars removed from closed file " + this.viperFile.name(), LogLevel.Info)
                    this.removingSpecialChars = false;
                    this.viperFile.specialCharsShown = false;
                    callback();
                }
                else {
                    this.removingSpecialChars = false;
                    Log.log("WARNING: cannot remove special chars from closed file: does it still exist?" + err.message, LogLevel.Debug);
                }
            });
        } catch (e) {
            this.removingSpecialChars = false;
            Log.error("Error removing special chars form closed file: " + e);
        }
    }
}