import * as vscode from 'vscode';
import * as languageClient from "vscode-languageclient";
import * as languageClientNode from "vscode-languageclient/node";
import * as path from "path";
import * as fs from "fs";

const languageServerPath : string = "server/DenizenLangServer.dll";

let configuration : vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration();

let headerSymbols : string = "|+=#_@/";

let outputChannel = vscode.window.createOutputChannel("Denizen");

let debugHighlighting : boolean = false;
let debugFolding : boolean = false;

class HighlightCache {
    needRefreshStartLine : number = -1;
    needRefreshEndLine : number = -1;
    needRefreshLineShift : number = 0;
    lastDecorations : { [color: string]: vscode.Range[] } = {};
}

let HLCaches : Map<string, HighlightCache> = new Map<string, HighlightCache>();

function getCache(path : string) {
    let result : HighlightCache = HLCaches.get(path);
    if (result) {
        return result;
    }
    result = new HighlightCache();
    HLCaches.set(path, result);
    return result;
}

function activateLanguageServer(context: vscode.ExtensionContext, dotnetPath : string) {
    if (!dotnetPath || dotnetPath.length === 0) {
        dotnetPath = "dotnet";
    }
    let pathFile : string = context.asAbsolutePath(languageServerPath);
    if (!fs.existsSync(pathFile)) {
        return;
    }
    let pathDir : string = path.dirname(pathFile);
    let serverOptions: languageClientNode.ServerOptions = {
        run: { command: dotnetPath, args: [pathFile], options: { cwd: pathDir } },
        debug: { command: dotnetPath, args: [pathFile, "--debug"], options: { cwd: pathDir } }
    }
    let clientOptions: languageClient.LanguageClientOptions = {
        documentSelector: ["denizenscript"],
        synchronize: {
            configurationSection: "denizenscript",
        },
    }
    let client = new languageClientNode.LanguageClient("DenizenLangServer", "Denizen Language Server", serverOptions, clientOptions);
    let disposable = client.start();
    context.subscriptions.push(disposable);
}

const highlightDecors: { [color: string]: vscode.TextEditorDecorationType } = {};

function colorSet(name : string, incolor : string) {
    const colorSplit : string[] = incolor.split('\|');
    let resultColor : vscode.DecorationRenderOptions = { color : colorSplit[0] };
    for (const i in colorSplit) {
        const subValueSplit = colorSplit[i].split('=', 2);
        const subValueSetting = subValueSplit[0];
        if (subValueSetting == "style") {
            resultColor.fontStyle = subValueSplit[1];
        }
        else if (subValueSetting == "background") {
            resultColor.backgroundColor = subValueSplit[1];
        }
    }
    highlightDecors[name] = vscode.window.createTextEditorDecorationType(resultColor);
}

const colorTypes : string[] = [
    "comment_header", "comment_normal", "comment_todo", "comment_code",
    "key", "key_inline", "command", "quote_double", "quote_single", "def_name",
    "tag", "tag_dot", "tag_param", "tag_param_bracket", "bad_space", "colons", "space", "normal"
];

function loadAllColors() {
    configuration = vscode.workspace.getConfiguration();
    for (const i in colorTypes) {
        let str : string = configuration.get("denizenscript.theme_colors." + colorTypes[i]);
        if (str === undefined) {
            outputChannel.appendLine("Missing color config for " + colorTypes[i]);
            continue;
        }
        colorSet(colorTypes[i], str);
    }
    headerSymbols = configuration.get("denizenscript.header_symbols");
    debugHighlighting = configuration.get("denizenscript.debug.highlighting");
    debugFolding = configuration.get("denizenscript.debug.folding");
}

function activateHighlighter(context: vscode.ExtensionContext) {
    loadAllColors();
}

let refreshTimer: NodeJS.Timer | undefined = undefined;

function refreshDecor() {
    refreshTimer = undefined;
    for (const editor of vscode.window.visibleTextEditors) {
        const uri = editor.document.uri.toString();
        if (!uri.endsWith(".dsc")) {
            continue;
        }
        decorateFullFile(editor);
    }
}

function addDecor(decorations: { [color: string]: vscode.Range[] }, type: string, lineNumber: number, startChar: number, endChar: number) {
    decorations[type].push(new vscode.Range(new vscode.Position(lineNumber, startChar), new vscode.Position(lineNumber, endChar)));
}

function decorateTag(tag : string, start: number, lineNumber: number, decorations: { [color: string]: vscode.Range[] }) {
    const len : number = tag.length;
    let inTagCounter : number = 0;
    let tagStart : number = 0;
    let inTagParamCounter : number = 0;
    let defaultDecor : string = "tag";
    let lastDecor : number = -1; // Color the < too.
    for (let i = 0; i < len; i++) {
        const c : string = tag.charAt(i);
        if (c == '<') {
            inTagCounter++;
            if (inTagCounter == 1) {
                addDecor(decorations, defaultDecor, lineNumber, start + lastDecor, start + i);
                lastDecor = i;
                defaultDecor = "tag";
                tagStart = i;
            }
        }
        else if (c == '>' && inTagCounter > 0) {
            inTagCounter--;
            if (inTagCounter == 0) {
                decorateTag(tag.substring(tagStart + 1, i), start + tagStart + 1, lineNumber, decorations);
                addDecor(decorations, "tag", lineNumber, start + i, start + i + 1);
                defaultDecor = inTagParamCounter > 0 ? "tag_param" : "tag";
                lastDecor = i + 1;
            }
        }
        else if (c == '[' && inTagCounter == 0 && i + 1 < len) {
            inTagParamCounter++;
            if (inTagParamCounter == 1) {
                addDecor(decorations, defaultDecor, lineNumber, start + lastDecor, start + i);
                addDecor(decorations, "tag_param_bracket", lineNumber, start + i, start + i + 1);
                lastDecor = i + 1;
                if (i == 0) {
                    defaultDecor = "def_name";
                }
                else {
                    defaultDecor = "tag_param";
                }
            }
        }
        else if (c == ']' && inTagCounter == 0) {
            inTagParamCounter--;
            if (inTagParamCounter == 0) {
                addDecor(decorations, defaultDecor, lineNumber, start + lastDecor, start + i);
                addDecor(decorations, "tag_param_bracket", lineNumber, start + i, start + i + 1);
                defaultDecor = "tag";
                lastDecor = i + 1;
            }
        }
        else if ((c == '.' || c == '|') && inTagCounter == 0 && inTagParamCounter == 0) {
            addDecor(decorations, defaultDecor, lineNumber, start + lastDecor, start + i);
            lastDecor = i + 1;
            addDecor(decorations, "tag_dot", lineNumber, start + i, start + i + 1);
        }
        else if (c == ' ' && inTagCounter == 0) {
            addDecor(decorations, defaultDecor, lineNumber, start + lastDecor, start + i);
            addDecor(decorations, "space", lineNumber, start + i, start + i + 1);
            lastDecor = i + 1;
        }
    }
    if (lastDecor < len) {
        addDecor(decorations, defaultDecor, lineNumber, start + lastDecor, start + len);
    }
}

const ifOperators : string[] = [ "<", ">", "<=", ">=", "==", "!=", "||", "&&", "(", ")", "or", "not", "and", "in", "contains", "!in", "!contains", "matches", "!matches" ];

const ifCmdLabels : string[] = [ "cmd:if", "cmd:else", "cmd:while", "cmd:waituntil" ];

const deffableCmdLabels : string[] = [ "cmd:run", "cmd:runlater", "cmd:clickable", "cmd:bungeerun" ];

function checkIfHasTagEnd(arg : string, quoted: boolean, quoteMode: string, canQuote : boolean) : boolean {
    const len : number = arg.length;
    for (let i = 0; i < len; i++) {
        const c : string = arg.charAt(i);
        if (canQuote && (c == '"' || c == '\'')) {
            if (quoted && c == quoteMode) {
                quoted = false;
            }
            else if (!quoted) {
                quoted = true;
                quoteMode = c;
            }
        }
        else if (c == '>') {
            return true;
        }
        else if (c == ' ' && !quoted && canQuote) {
            return false;
        }
    }
    return false;
}

function decorateArg(arg : string, start: number, lineNumber: number, decorations: { [color: string]: vscode.Range[] }, canQuote : boolean, contextualLabel : string) {
    const len : number = arg.length;
    let quoted : boolean = false;
    let quoteMode : string = 'x';
    let inTagCounter : number = 0;
    let tagStart : number = 0;
    const referenceDefault = contextualLabel == "key:definitions" ? "def_name" : "normal";
    let defaultDecor : string = referenceDefault;
    let lastDecor : number = 0;
    let hasTagEnd : boolean = checkIfHasTagEnd(arg, false, 'x', canQuote);
    let spaces : number = 0;
    for (let i = 0; i < len; i++) {
        const c : string = arg.charAt(i);
        if (canQuote && (c == '"' || c == '\'')) {
            if (quoted && c == quoteMode) {
                addDecor(decorations, defaultDecor, lineNumber, start + lastDecor, start + i + 1);
                lastDecor = i + 1;
                defaultDecor = referenceDefault;
                quoted = false;
            }
            else if (!quoted) {
                addDecor(decorations, defaultDecor, lineNumber, start + lastDecor, start + i);
                lastDecor = i;
                quoted = true;
                defaultDecor = c == '"' ? "quote_double" : "quote_single";
                quoteMode = c;
            }
        }
        else if (hasTagEnd && c == '<' && i + 1 < len && arg.charAt(i + 1) != '-') {
            inTagCounter++;
            if (inTagCounter == 1) {
                addDecor(decorations, defaultDecor, lineNumber, start + lastDecor, start + i);
                lastDecor = i;
                tagStart = i;
                defaultDecor = "tag";
            }
        }
        else if (hasTagEnd && c == '>' && inTagCounter > 0) {
            inTagCounter--;
            if (inTagCounter == 0) {
                decorateTag(arg.substring(tagStart + 1, i), start + tagStart + 1, lineNumber, decorations);
                addDecor(decorations, "tag", lineNumber, start + i, start + i + 1);
                defaultDecor = quoted ? (quoteMode == '"' ? "quote_double" : "quote_single") : referenceDefault;
                lastDecor = i + 1;
            }
        }
        else if (inTagCounter == 0 && c == '|' && contextualLabel == "key:definitions") {
            addDecor(decorations, defaultDecor, lineNumber, start + lastDecor, start + i);
            addDecor(decorations, "normal", lineNumber, start + i, start + i + 1);
            lastDecor = i + 1;
        }
        else if (inTagCounter == 0 && c == ':' && deffableCmdLabels.includes(contextualLabel.replace("~", ""))) {
            const part : string = arg.substring(lastDecor, i);
            if (part.startsWith("def.") && !part.includes('<') && !part.includes(' ')) {
                addDecor(decorations, defaultDecor, lineNumber, start + lastDecor, start + "def.".length);
                addDecor(decorations, "def_name", lineNumber, start + lastDecor + "def.".length, start + i);
                lastDecor = i;
            }
        }
        else if (c == ' ' && ((!quoted && canQuote) || inTagCounter == 0)) {
            hasTagEnd = checkIfHasTagEnd(arg.substring(i + 1), quoted, quoteMode, canQuote);
            addDecor(decorations, defaultDecor, lineNumber, start + lastDecor, start + i);
            addDecor(decorations, "space", lineNumber, start + i, start + i + 1);
            lastDecor = i + 1;
            if (!quoted) {
                inTagCounter = 0;
                defaultDecor = referenceDefault;
                spaces++;
            }
            const nextArg : string = arg.includes(" ", i + 1) ? arg.substring(i + 1, arg.indexOf(" ", i + 1)) : arg.substring(i + 1);
            if (!quoted && canQuote) {
                if (ifOperators.includes(nextArg) && ifCmdLabels.includes(contextualLabel)) {
                    addDecor(decorations, "colons", lineNumber, start + i + 1, start + i + 1 + nextArg.length);
                    i += nextArg.length;
                    lastDecor = i;
                }
                else if (nextArg.startsWith("as:") && !nextArg.includes("<") && (contextualLabel == "cmd:foreach" || contextualLabel == "cmd:repeat")) {
                    addDecor(decorations, "normal", lineNumber, start + i + 1, start + i + 1 + "as:".length);
                    addDecor(decorations, "def_name", lineNumber, start + i + 1 + "as:".length, start + i + 1 + nextArg.length);
                    i += nextArg.length;
                    lastDecor = i;
                }
                else if (nextArg.startsWith("key:") && !nextArg.includes("<") && contextualLabel == "cmd:foreach") {
                    addDecor(decorations, "normal", lineNumber, start + i + 1, start + i + 1 + "key:".length);
                    addDecor(decorations, "def_name", lineNumber, start + i + 1 + "key:".length, start + i + 1 + nextArg.length);
                    i += nextArg.length;
                    lastDecor = i;
                }
                else if (spaces == 1 && (contextualLabel == "cmd:define" || contextualLabel == "cmd:definemap")) {
                    let colonIndex : number = nextArg.indexOf(':');
                    if (colonIndex == -1) {
                        colonIndex = nextArg.length;
                    }
                    const tagMark : number = nextArg.indexOf('<');
                    if (tagMark == -1 || tagMark > colonIndex) {
                        addDecor(decorations, "def_name", lineNumber, start + i + 1, start + i + 1 + colonIndex);
                        const argStart : string = nextArg.charAt(0);
                        if (!quoted && canQuote && (argStart == '"' || argStart == '\'')) {
                            quoted = true;
                            defaultDecor = argStart == '"' ? "quote_double" : "quote_single";
                            quoteMode = argStart;
                        }
                        i += colonIndex;
                        lastDecor = i;
                    }
                }
            }
        }
    }
    if (lastDecor < len) {
        addDecor(decorations, defaultDecor, lineNumber, start + lastDecor, start + len);
    }
}

function decorateComment(line : string, lineNumber: number, decorType: string, decorations: { [color: string]: vscode.Range[] }) {
    decorateSpaceable(line, 0, lineNumber, decorType, decorations);
}

function decorateSpaceable(line : string, preLength: number, lineNumber: number, decorType: string, decorations: { [color: string]: vscode.Range[] }) {
    const len : number = line.length;
    let lastDecor : number = 0;
    for (let i = 0; i < len; i++) {
        const c : string = line.charAt(i);
        if (c == ' ') {
            addDecor(decorations, decorType, lineNumber, preLength + lastDecor, preLength + i);
            addDecor(decorations, "space", lineNumber, preLength + i, preLength + i + 1);
            lastDecor = i + 1;
        }
    }
    if (lastDecor < len) {
        addDecor(decorations, decorType, lineNumber, preLength + lastDecor, preLength + len);
    }
}

const definiteNotScriptKeys : string[] = [
    "interact scripts", "default constants", "data", "constants", "text", "lore", "aliases", "slots", "enchantments", "input"
];

function decorateLine(line : string, lineNumber: number, decorations: { [color: string]: vscode.Range[] }, lastKey : string) {
    if (line.endsWith("\r")) {
        line = line.substring(0, line.length - 1);
    }
    const trimmedEnd : string = line.trimRight();
    let trimmed : string = trimmedEnd.trimLeft();
    if (trimmed.length == 0) {
        return;
    }
    if (trimmedEnd.length != line.length) {
        addDecor(decorations, "bad_space", lineNumber, trimmedEnd.length, line.length);
    }
    const preSpaces = trimmedEnd.length - trimmed.length;
    if (trimmed.startsWith("#")) {
        const afterComment = trimmed.substring(1).trim();
        const symbol = afterComment.length == 0 ? ' ' : afterComment.charAt(0);
        if (headerSymbols.includes(symbol)) {
            decorateComment(line, lineNumber, "comment_header", decorations);
        }
        else if (afterComment.startsWith("-")) {
            decorateComment(line, lineNumber, "comment_code", decorations);
        }
        else if (afterComment.toLowerCase().startsWith("todo")) {
            decorateComment(line, lineNumber, "comment_todo", decorations);
        }
        else {
            decorateComment(line, lineNumber, "comment_normal", decorations);
        }
    }
    else if (trimmed.startsWith("-")) {
        const isNonScript : boolean = definiteNotScriptKeys.includes(lastKey);
        addDecor(decorations, "normal", lineNumber, preSpaces, preSpaces + 1);
        if (isNonScript) {
            decorateArg(trimmed.substring(1), preSpaces + 1, lineNumber, decorations, false, "non-script");
        }
        else {
            if (trimmed.endsWith(":")) {
                addDecor(decorations, "colons", lineNumber, preSpaces + trimmed.length - 1, preSpaces + trimmed.length);
                trimmed = trimmed.substring(0, trimmed.length - 1);
            }
            const afterDash : string = trimmed.substring(1);
            const commandEnd : number = afterDash.indexOf(' ', 1) + 1;
            const endIndexCleaned : number = preSpaces + (commandEnd == 0 ? trimmed.length : commandEnd);
            const commandText = commandEnd == 0 ? afterDash : afterDash.substring(0, commandEnd);
            if (!afterDash.startsWith(" ")) {
                addDecor(decorations, "bad_space", lineNumber, preSpaces + 1, endIndexCleaned);
                decorateArg(trimmed.substring(commandEnd), preSpaces + commandEnd, lineNumber, decorations, false, "cmd:" + commandText.trim());
            }
            else {
                if (commandText.includes("'") || commandText.includes("\"") || commandText.includes("[")) {
                    decorateArg(trimmed.substring(2), preSpaces + 2, lineNumber, decorations, false, "non-cmd");
                }
                else {
                    addDecor(decorations, "command", lineNumber, preSpaces + 2, endIndexCleaned);
                    if (commandEnd > 0) {
                        decorateArg(trimmed.substring(commandEnd), preSpaces + commandEnd, lineNumber, decorations, true, "cmd:" + commandText.trim());
                    }
                }
            }
        }
    }
    else if (trimmed.endsWith(":")) {
        decorateSpaceable(trimmed.substring(0, trimmed.length - 1), preSpaces, lineNumber, "key", decorations);
        addDecor(decorations, "colons", lineNumber, trimmedEnd.length - 1, trimmedEnd.length);
    }
    else if (trimmed.includes(":")) {
        const colonIndex = line.indexOf(':');
        const key = trimmed.substring(0, colonIndex - preSpaces);
        decorateSpaceable(key, preSpaces, lineNumber, "key", decorations);
        addDecor(decorations, "colons", lineNumber, colonIndex, colonIndex + 1);
        decorateArg(trimmed.substring(colonIndex - preSpaces + 1), colonIndex + 1, lineNumber, decorations, false, "key:" + key);
    }
    else {
        addDecor(decorations, "bad_space", lineNumber, preSpaces, line.length);
    }
}

function decorateFullFile(editor: vscode.TextEditor) {
    let decorations: { [color: string]: vscode.Range[] } = {};
    let highlight : HighlightCache = getCache(editor.document.uri.toString());
    if (Object.keys(highlight.lastDecorations).length === 0) {
        highlight.needRefreshStartLine = -1;
    }
    if (highlight.needRefreshStartLine == -1) {
        for (const c in highlightDecors) {
            decorations[c] = [];
        }
    }
    else {
        if (highlight.needRefreshLineShift > 0) {
            highlight.needRefreshEndLine += highlight.needRefreshLineShift;
        }
        if (highlight.needRefreshLineShift < 0) {
            highlight.needRefreshStartLine += highlight.needRefreshLineShift;
        }
        decorations = highlight.lastDecorations;
        for (const c in highlightDecors) {
            const rangeSet : vscode.Range[] = decorations[c];
            if (highlight.needRefreshLineShift != 0) {
                for (let i : number = rangeSet.length - 1; i >= 0; i--) {
                    if (highlight.needRefreshLineShift > 0 ? (rangeSet[i].start.line >= highlight.needRefreshEndLine - highlight.needRefreshLineShift) : (rangeSet[i].start.line >= highlight.needRefreshStartLine - highlight.needRefreshLineShift)) {
                        rangeSet[i] = new vscode.Range(new vscode.Position(rangeSet[i].start.line + highlight.needRefreshLineShift, rangeSet[i].start.character), new vscode.Position(rangeSet[i].end.line + highlight.needRefreshLineShift, rangeSet[i].end.character));
                    }
                }
            }
            for (let i : number = rangeSet.length - 1; i >= 0; i--) {
                if (rangeSet[i].start.line <= highlight.needRefreshEndLine && rangeSet[i].end.line >= highlight.needRefreshStartLine) {
                    rangeSet.splice(i, 1);
                }
            }
        }
    }
    const fullText : string = editor.document.getText();
    const splitText : string[] = fullText.split('\n');
    const totalLines = splitText.length;
    let lastKey : string = "";
    const startLine : number = (highlight.needRefreshStartLine == -1 ? 0 : highlight.needRefreshStartLine);
    const endLine : number = (highlight.needRefreshStartLine == -1 ? totalLines : Math.min(highlight.needRefreshEndLine + 1, totalLines));
    if (debugHighlighting) {
        if (highlight.needRefreshStartLine == -1) {
            let type : String = "normal";
            if (highlight.needRefreshEndLine == 999999) {
                type = "forced";
            }
            else if (Object.keys(highlight.lastDecorations).length === 0) {
                type = "missing-keys-induced";
            }
            outputChannel.appendLine("Doing " + type + " full highlight of entire file, for file: " + editor.document.fileName);
        }
        else {
            outputChannel.appendLine("Doing partial highlight of file from start " + startLine + " to end " + endLine + ", for file: " + editor.document.fileName);
        }
    }
    // Figure out the initial lastKey if needed
    for (let i : number = startLine - 1; i >= 0; i--) {
        const lineText : string = splitText[i];
        const trimmedLine = lineText.trim();
        if (trimmedLine.endsWith(":") && !trimmedLine.startsWith("-"))
        {
            lastKey = trimmedLine.substring(0, trimmedLine.length - 1).toLowerCase();
            break;
        }
    }
    // Actually choose colors
    for (let i : number = startLine; i < endLine; i++) {
        const lineText : string = splitText[i];
        const trimmedLine = lineText.trim();
        if (trimmedLine.endsWith(":") && !trimmedLine.startsWith("-"))
        {
            lastKey = trimmedLine.substring(0, trimmedLine.length - 1).toLowerCase();
        }
        decorateLine(lineText, i, decorations, lastKey);
    }
    // Apply them
    for (const c in decorations) {
        editor.setDecorations(highlightDecors[c], decorations[c]);
    }
    highlight.lastDecorations = decorations;
    highlight.needRefreshStartLine = -1;
    highlight.needRefreshEndLine = -1;
    highlight.needRefreshLineShift = 0;
}

function denizenScriptFoldingProvider(document: vscode.TextDocument, context: vscode.FoldingContext, token: vscode.CancellationToken) : vscode.ProviderResult<vscode.FoldingRange[]> {
    const fullText : string = document.getText();
    const splitText : string[] = fullText.split('\n');
    const totalLines = splitText.length;
    const output : vscode.FoldingRange[] = [];
    const processing : InProcFold[] = [];
    if (debugFolding) {
        outputChannel.appendLine("(FOLDING) Begin");
    }
    for (let i : number = 0; i < totalLines; i++) {
        const line : string = splitText[i];
        const preTrimmed : string = line.trimStart();
        if (preTrimmed.length == 0) {
            continue;
        }
        const spaces : number = line.length - preTrimmed.length;
        const fullTrimmed : string = preTrimmed.trimEnd();
        const isBlock : boolean = fullTrimmed.endsWith(":");
        const isCommand : boolean = fullTrimmed.startsWith("-");
        while (processing.length > 0) {
            const lastFold : InProcFold = processing[processing.length - 1];
            if (lastFold.spacing > spaces || spaces == 0 || (lastFold.spacing == spaces && ((isBlock && !isCommand) || lastFold.isCommand))) {
                processing.pop();
                output.push(new vscode.FoldingRange(lastFold.start, i - 1));
                if (debugFolding) {
                    outputChannel.appendLine("(FOLDING) Found an end at " + i);
                }
            }
            else {
                break;
            }
        }
        if (isBlock) {
            processing.push(new InProcFold(i, spaces, isCommand));
            if (debugFolding) {
                outputChannel.appendLine("(FOLDING) Found a start at " + i);
            }
        }
    }
    if (debugFolding) {
        outputChannel.appendLine("(FOLDING) Folds calculated with " + output.length + " normal and " + processing.length + " left");
    }
    for (let i : number = 0; i < processing.length; i++) { // for-each style loop bugs out and thinks the value is a String, so have to do 'i' counter style loop
        const extraFold : InProcFold = processing[i];
        output.push(new vscode.FoldingRange(extraFold.start, totalLines - 1));
    }
    return output;
}

function scheduleRefresh() {
    if (refreshTimer) {
        return;
    }
    refreshTimer = setTimeout(refreshDecor, 50);
}

async function activateDotNet() {
    try {
        outputChannel.appendLine("DenizenScript extension attempting to acquire .NET 6");
        const requestingExtensionId = 'DenizenScript.denizenscript';
        const result = await vscode.commands.executeCommand('dotnet.acquire', { version: '6.0', requestingExtensionId });
        outputChannel.appendLine("DenizenScript extension NET 6 Acquire result: " + result + ": " + result["dotnetPath"]);
        return result["dotnetPath"];
    }
    catch (error) {
        outputChannel.appendLine("Error: " + error);
        return "";
    }
}

function forceRefresh(reason: String) {
    if (debugHighlighting) {
        outputChannel.appendLine("Scheduled a force full refresh of syntax highlighting because: " + reason);
    }
    HLCaches.clear();
    scheduleRefresh();
}

export async function activate(context: vscode.ExtensionContext) {
    let path : string = await activateDotNet();
    activateLanguageServer(context, path);
    activateHighlighter(context);
    vscode.workspace.onDidOpenTextDocument(doc => {
        if (doc.uri.toString().endsWith(".dsc")) {
            forceRefresh("onDidOpenTextDocument");
        }
    }, null, context.subscriptions);
    vscode.workspace.onDidChangeTextDocument(event => {
        const curFile : string = event.document.uri.toString();
        if (curFile.endsWith(".dsc")) {
            let highlight : HighlightCache = getCache(curFile);
            event.contentChanges.forEach(change => {
                if (highlight.needRefreshStartLine == -1 || change.range.start.line < highlight.needRefreshStartLine) {
                    highlight.needRefreshStartLine = change.range.start.line;
                }
                if (highlight.needRefreshEndLine == -1 || change.range.end.line > highlight.needRefreshEndLine) {
                    highlight.needRefreshEndLine = change.range.end.line;
                }
                highlight.needRefreshLineShift += change.text.split('\n').length - 1;
                highlight.needRefreshLineShift -= event.document.getText(change.range).split('\n').length - 1;
            });
            if (debugHighlighting) {
                outputChannel.appendLine("Scheduled a partial refresh of syntax highlighting because onDidChangeTextDocument, from " + highlight.needRefreshStartLine + " to " + highlight.needRefreshEndLine + " with shift " + highlight.needRefreshLineShift);
            }
            scheduleRefresh();
        }
    }, null, context.subscriptions);
    vscode.window.onDidChangeVisibleTextEditors(editors => {
        forceRefresh("onDidChangeVisibleTextEditors");
    }, null, context.subscriptions);
    vscode.workspace.onDidChangeConfiguration(event => {
        loadAllColors();
        forceRefresh("onDidChangeConfiguration");
    });
    vscode.languages.registerFoldingRangeProvider('denizenscript', {
        provideFoldingRanges(document: vscode.TextDocument, context: vscode.FoldingContext, token: vscode.CancellationToken) : vscode.ProviderResult<vscode.FoldingRange[]> {
            return denizenScriptFoldingProvider(document, context, token);
        }
    });
    scheduleRefresh();
    outputChannel.appendLine('Denizen extension has been activated');
}

class InProcFold {
    start : number;
    spacing : number;
    isCommand : boolean;
    constructor(start: number, spacing: number, isCommand : boolean) {
        this.start = start;
        this.spacing = spacing;
        this.isCommand = isCommand;
    }
}

export function deactivate() {
}
