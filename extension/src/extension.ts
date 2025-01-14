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
let doInlineColors : boolean = true;
let displayDarkColors : boolean = false;

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
const highlightColorRef: { [color: string]: string } = {};

function parseColor(inColor : string) : vscode.DecorationRenderOptions {
    const colorSplit : string[] = inColor.split('\|');
    let resultColor : vscode.DecorationRenderOptions = { color : colorSplit[0] };
    let strike : boolean = false;
    let underline : boolean = false;
    for (const i in colorSplit) {
        const subValueSplit = colorSplit[i].split('=', 2);
        const subValueSetting = subValueSplit[0];
        if (subValueSetting == "style") {
            resultColor.fontStyle = subValueSplit[1];
        }
        else if (subValueSetting == "weight") {
            resultColor.fontWeight = subValueSplit[1];
        }
        else if (subValueSetting == "strike") {
            strike = subValueSplit[1] == "true";
        }
        else if (subValueSetting == "underline") {
            underline = subValueSplit[1] == "true";
        }
        else if (subValueSetting == "background") {
            resultColor.backgroundColor = subValueSplit[1];
        }
    }
    if (strike || underline) {
        if (strike && !underline) {
            resultColor.textDecoration = "line-through";
        }
        else if (underline && !strike) {
            resultColor.textDecoration = "underline";
        }
        else {
            resultColor.textDecoration = "underline line-through";
        }
    }
    return resultColor;
}

function colorSet(name : string, inColor : string) {
    highlightDecors[name] = vscode.window.createTextEditorDecorationType(parseColor(inColor));
    highlightColorRef[name] = inColor;
}

const colorTypes : string[] = [
    "comment_header", "comment_normal", "comment_todo", "comment_code",
    "key", "key_inline", "command", "quote_double", "quote_single", "def_name",
    "event_line", "event_switch", "event_switch_value",
    "tag", "tag_dot", "tag_param", "tag_param_bracket",
    "bad_space", "space", "normal",
    "colons", "if_operators", "data_actions"
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
    doInlineColors = configuration.get("denizenscript.behaviors.do_inline_colors");
    displayDarkColors = configuration.get("denizenscript.behaviors.display_dark_colors");
    const customColors : string = configuration.get("denizenscript.theme_colors.text_color_map");
    const colorsSplit : string[] = customColors.split(',');
    for (const i in colorsSplit) {
        const color = colorsSplit[i];
        let pair : string[] = color.split('=');
        if (pair.length == 2) {
            tagSpecialColors["&[" + pair[0].toLowerCase() + "]"] = pair[1];
        }
        else {
            outputChannel.appendLine("Cannot interpret color " + color);
        }
    }
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
    if (!(type in highlightDecors) && type.startsWith("auto:")) {
        highlightDecors[type] = vscode.window.createTextEditorDecorationType(parseColor(type.substring("auto:".length)));
        decorations[type] = [];
    }
    decorations[type].push(new vscode.Range(new vscode.Position(lineNumber, startChar), new vscode.Position(lineNumber, endChar)));
}

function decorateTag(tag : string, start: number, lineNumber: number, decorations: { [color: string]: vscode.Range[] }) {
    const len : number = tag.length;
    let inTagCounter : number = 0;
    let tagStart : number = 0;
    let inTagParamCounter : number = 0;
    let defaultDecor : string = "tag";
    let lastDecor : number = -1; // Color the < too.
    let textColor : string = "tag_param";
    let lastDot : number = 0;
    let lastBracket : number = 0;
    for (let i = 0; i < len; i++) {
        const c : string = tag.charAt(i);
        if (c == '<') {
            inTagCounter++;
            if (inTagCounter == 1) {
                addDecor(decorations, defaultDecor, lineNumber, start + lastDecor, start + i);
                lastDecor = i;
                textColor = defaultDecor;
                defaultDecor = "tag";
                tagStart = i;
                lastDot = i;
            }
        }
        else if (c == '>' && inTagCounter > 0) {
            inTagCounter--;
            if (inTagCounter == 0) {
                const tagText : string = tag.substring(tagStart + 1, i);
                let autoColor : string = getTagColor(tagText, textColor);
                if (autoColor != null) {
                    addDecor(decorations, "auto:" + autoColor, lineNumber, start + tagStart + 1, start + i);
                    addDecor(decorations, "tag", lineNumber, start + tagStart, start + tagStart + 1);
                    defaultDecor = "auto:" + autoColor;
                    textColor = defaultDecor;
                }
                else {
                    decorateTag(tagText, start + tagStart + 1, lineNumber, decorations);
                    defaultDecor = inTagParamCounter > 0 ? textColor : "tag";
                }
                addDecor(decorations, "tag", lineNumber, start + i, start + i + 1);
                lastDecor = i + 1;
            }
        }
        else if (c == '[' && inTagCounter == 0 && i + 1 < len) {
            inTagParamCounter++;
            if (inTagParamCounter == 1) {
                lastBracket = i;
                addDecor(decorations, defaultDecor, lineNumber, start + lastDecor, start + i);
                addDecor(decorations, "tag_param_bracket", lineNumber, start + i, start + i + 1);
                lastDecor = i + 1;
                if (i == 0) {
                    defaultDecor = "def_name";
                }
                else {
                    const lastTag : string = tag.substring(0, i);
                    if (lastTag.endsWith(".flag") || lastTag.endsWith(".flag_expiration") || lastTag.endsWith(".has_flag")) {
                        defaultDecor = "def_name";
                    }
                    else {
                        defaultDecor = "tag_param";
                    }
                }
            }
        }
        else if (c == ']' && inTagCounter == 0) {
            inTagParamCounter--;
            if (inTagParamCounter == 0) {
                const lastTag : string = tag.substring(lastDot + 1, lastBracket);
                const bracketedText : string = tag.substring(lastBracket + 1, i);
                const colorFormat = "&[" + bracketedText.toLowerCase() + "]";
                if (lastTag == "custom_color" && !bracketedText.includes('<') && colorFormat in tagSpecialColors) {
                    const color : string = tagSpecialColors[colorFormat];
                    addDecor(decorations, "auto:" + color, lineNumber, start + lastDecor, start + i);
                }
                else if (defaultDecor == "def_name") {
                    decorateDefName(decorations, tag.substring(lastDecor, i), lineNumber, start + lastDecor);
                }
                else {
                    addDecor(decorations, defaultDecor, lineNumber, start + lastDecor, start + i);
                }
                addDecor(decorations, "tag_param_bracket", lineNumber, start + i, start + i + 1);
                defaultDecor = "tag";
                lastDecor = i + 1;
            }
        }
        else if ((c == '.' || c == '|') && inTagCounter == 0 && inTagParamCounter == 0) {
            addDecor(decorations, defaultDecor, lineNumber, start + lastDecor, start + i);
            lastDecor = i + 1;
            addDecor(decorations, "tag_dot", lineNumber, start + i, start + i + 1);
            lastDot = i;
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
    let params : number = 0;
    let hasFallback : boolean = false;
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
        else if (c == '[') {
            params++;
        }
        else if (c == ']' && params > 0) {
            params--;
        }
        else if (c == '>') {
            return true;
        }
        else if (c == ' ' && !quoted && canQuote && params == 0 && !hasFallback) {
            return false;
        }
        else if (c == '|' && i > 0 && arg.charAt(i - 1) == '|') {
            hasFallback = true;
        }
    }
    return false;
}


const tagSpecialColors: { [color: string]: string } = {
    "&0": "#000000", "black": "#000000",
    "&1": "#0000AA", "dark_blue": "#0000AA",
    "&2": "#00AA00", "dark_green": "#00AA00",
    "&3": "#00AAAA", "dark_aqua": "#00AAAA",
    "&4": "#AA0000", "dark_red": "#AA0000",
    "&5": "#AA00AA", "dark_purple": "#AA00AA",
    "&6": "#FFAA00", "gold": "#FFAA00",
    "&7": "#AAAAAA", "gray": "#AAAAAA",
    "&8": "#555555", "dark_gray": "#555555",
    "&9": "#5555FF", "blue": "#5555FF",
    "&a": "#55FF55", "green": "#55FF55",
    "&b": "#55FFFF", "aqua": "#55FFFF",
    "&c": "#FF5555", "red": "#FF5555",
    "&d": "#FF55FF", "light_purple": "#FF55FF",
    "&e": "#FFFF55", "yellow": "#FFFF55",
    "&f": "#FFFFFF", "white": "#FFFFFF", "&r": "#FFFFFF", "reset": "#FFFFFF"
};
const formatCodes: { [code: string]: string } = {
    "&l": "bold", "bold": "bold",
    "&o": "italic", "italic": "italic",
    "&m": "strike", "strikethrough": "strike",
    "&n": "underline", "underline": "underline"
};

const hexChars: { [c: string] : boolean } = {}
const hexRefStr = "abcdefABCDEF0123456789";
for (let hexID = 0; hexID < hexRefStr.length; hexID++) {
    hexChars[hexRefStr.charAt(hexID)] = true;
}

function isHex(text : string) : boolean {
    for (let i = 0; i < text.length; i++) {
        let c : string = text.charAt(i);
        if (!(c in hexChars)) {
            return false;
        }
    }
    return true;
}

function getColorData(color : string) : string {
    if (color.startsWith("#")) {
        return color;
    }
    if (color.startsWith("auto:#")) {
        return color.substring("auto:".length);
    }
    const knownColor : string = highlightColorRef[color];
    if (knownColor) {
        return knownColor;
    }
    return null;
}

function fixDark(color : string) {
    if (color == null) {
        return null;
    }
    if (displayDarkColors) {
        return color;
    }
    const splitter : number = color.indexOf('|');
    const part : string = splitter == -1 ? color : color.substring(0, splitter);
    if (!part.startsWith('#') || part.length < 7) {
        return color;
    }
    const red : number = parseInt(part.substring(1, 3), 16);
    const green : number = parseInt(part.substring(3, 5), 16);
    const blue : number = parseInt(part.substring(5, 7), 16);
    if (red < 64 && green < 64 && blue < 64) {
        return null;
    }
    return color;
}

function getTagColor(tagText : string, preColor : string) : string {
    if (!doInlineColors) {
        return null;
    }
    tagText = tagText.toLowerCase();
    if (tagText in tagSpecialColors) {
        return fixDark(tagSpecialColors[tagText]);
    }
    if (tagText.startsWith("&color[") && tagText.endsWith("]") && !tagText.includes(".")) {
        const colorText : string = tagText.substring("&color[".length, tagText.length - 1);
        if (colorText.length == 7 && colorText.startsWith("#") && isHex(colorText.substring(1))) {
            return fixDark(colorText);
        }
    }
    const formatter : string = formatCodes[tagText];
    if (formatter) {
        const rgb : string = getColorData(preColor);
        if (rgb) {
            if (formatter == "bold") {
                return rgb + "|weight=bold";
            }
            else if (formatter == "italic") {
                return rgb + "|style=italic";
            }
            else if (formatter == "strike") {
                return rgb + "|strike=true";
            }
            else if (formatter == "underline") {
                return rgb + "|underline=true";
            }
        }
    }
    return null;
}

const TAG_ALLOWED : string = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789&_[";
const dataActions : string[] = [ ":->:", ":<-:", ":|:", ":!", ":++", ":--", ":<-", ":+:", ":-:", ":*:", ":/:", ":" ];

function decorateArg(arg : string, start: number, lineNumber: number, decorations: { [color: string]: vscode.Range[] }, canQuote : boolean, contextualLabel : string) {
    const len : number = arg.length;
    let quoted : boolean = false;
    let quoteMode : string = 'x';
    let inTagCounter : number = 0;
    let tagStart : number = 0;
    const referenceDefault = "normal";
    let defaultDecor : string = referenceDefault;
    let lastDecor : number = 0;
    let hasTagEnd : boolean = checkIfHasTagEnd(arg, false, 'x', canQuote);
    let spaces : number = 0;
    let textColor : string = referenceDefault;
    for (let i = 0; i < len; i++) {
        const c : string = arg.charAt(i);
        if (canQuote && (c == '"' || c == '\'')) {
            if (quoted && c == quoteMode) {
                addDecor(decorations, defaultDecor, lineNumber, start + lastDecor, start + i);
                addDecor(decorations, c == '"' ? "quote_double" : "quote_single", lineNumber, start + i, start + i + 1);
                lastDecor = i + 1;
                defaultDecor = referenceDefault;
                textColor = defaultDecor;
                quoted = false;
            }
            else if (!quoted) {
                addDecor(decorations, defaultDecor, lineNumber, start + lastDecor, start + i);
                lastDecor = i;
                quoted = true;
                defaultDecor = c == '"' ? "quote_double" : "quote_single";
                textColor = defaultDecor;
                quoteMode = c;
            }
        }
        else if (hasTagEnd && c == '<' && i + 1 < len && TAG_ALLOWED.includes(arg.charAt(i + 1))) {
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
                const tagText : string = arg.substring(tagStart + 1, i);
                let autoColor : string = getTagColor(tagText, textColor);
                if (autoColor != null) {
                    addDecor(decorations, "tag", lineNumber, start + tagStart, start + tagStart + 1);
                    addDecor(decorations, "auto:" + autoColor, lineNumber, start + tagStart + 1, start + i);
                    defaultDecor = "auto:" + autoColor;
                    textColor = defaultDecor;
                }
                else {
                    decorateTag(tagText, start + tagStart + 1, lineNumber, decorations);
                    defaultDecor = textColor;
                }
                addDecor(decorations, "tag", lineNumber, start + i, start + i + 1);
                lastDecor = i + 1;
            }
        }
        else if (inTagCounter == 0 && c == ':' && deffableCmdLabels.includes(contextualLabel.replaceAll("~", ""))) {
            let part : string = arg.substring(lastDecor, i);
            let bump = 0;
            const origPart = part;
            if (canQuote && (part.startsWith("'") || part.startsWith('"'))) {
                part = part.substring(1);
                bump = 1;
            }
            if (part.startsWith("def.") && !part.includes('<') && !part.includes(' ')) {
                if (bump == 1) {
                    addDecor(decorations, origPart.startsWith('"') ? "quote_double" : "quote_single", lineNumber, start + lastDecor, start + lastDecor + 1);
                    addDecor(decorations, "normal", lineNumber, start + lastDecor + 1, start + lastDecor + 1 + "def.".length);
                }
                else {
                    addDecor(decorations, defaultDecor, lineNumber, start + lastDecor, start + lastDecor + "def.".length);
                }
                decorateDefName(decorations, part.substring("def.".length), lineNumber, start + bump + lastDecor + "def.".length);
                lastDecor = i;
            }
        }
        else if (c == ' ' && (quoted || !canQuote) && inTagCounter == 0) {
            addDecor(decorations, defaultDecor, lineNumber, start + lastDecor, start + i);
            addDecor(decorations, "space", lineNumber, start + i, start + i + 1);
            lastDecor = i + 1;
        }
        else if (c == ' ' && !quoted && canQuote && inTagCounter == 0) {
            hasTagEnd = checkIfHasTagEnd(arg.substring(i + 1), quoted, quoteMode, canQuote);
            addDecor(decorations, defaultDecor, lineNumber, start + lastDecor, start + i);
            addDecor(decorations, "space", lineNumber, start + i, start + i + 1);
            lastDecor = i + 1;
            if (!quoted) {
                inTagCounter = 0;
                defaultDecor = canQuote ? referenceDefault : textColor;
                spaces++;
            }
            const nextArg : string = arg.includes(" ", i + 1) ? arg.substring(i + 1, arg.indexOf(" ", i + 1)) : arg.substring(i + 1);
            if (!quoted && canQuote) {
                if (ifOperators.includes(nextArg) && ifCmdLabels.includes(contextualLabel)) {
                    addDecor(decorations, "if_operators", lineNumber, start + i + 1, start + i + 1 + nextArg.length);
                    i += nextArg.length;
                    lastDecor = i + 1;
                }
                else if (nextArg.startsWith("as:") && !nextArg.includes("<") && (contextualLabel == "cmd:foreach" || contextualLabel == "cmd:repeat")) {
                    addDecor(decorations, "normal", lineNumber, start + i + 1, start + i + 1 + "as:".length);
                    decorateDefName(decorations, nextArg.substring("as:".length), lineNumber, start + i + 1 + "as:".length);
                    i += nextArg.length;
                    lastDecor = i + 1;
                }
                else if (nextArg.startsWith("key:") && !nextArg.includes("<") && contextualLabel == "cmd:foreach") {
                    addDecor(decorations, "normal", lineNumber, start + i + 1, start + i + 1 + "key:".length);
                    decorateDefName(decorations, nextArg.substring("key:".length), lineNumber, start + i + 1 + "key:".length);
                    i += nextArg.length;
                    lastDecor = i + 1;
                }
                else if (spaces == 1 && (contextualLabel == "cmd:define" || contextualLabel == "cmd:definemap") || contextualLabel == "cmd:flag") {
                    let colonIndex : number = nextArg.indexOf(':');
                    if (colonIndex == -1) {
                        if (contextualLabel != "cmd:flag") {
                            colonIndex = nextArg.length;
                        }
                    }
                    if (contextualLabel == "cmd:flag" && nextArg.startsWith("expire:")) {
                        colonIndex = -1;
                    }
                    const tagMark : number = nextArg.indexOf('<');
                    if ((tagMark == -1 || tagMark > colonIndex) && colonIndex != -1) {
                        const argStart : string = nextArg.charAt(0);
                        let bump : number = 0;
                        if (!quoted && canQuote && (argStart == '"' || argStart == '\'')) {
                            quoted = true;
                            defaultDecor = argStart == '"' ? "quote_double" : "quote_single";
                            quoteMode = argStart;
                            bump = 1;
                            addDecor(decorations, defaultDecor, lineNumber, start + i + 1, start + i + 2);
                        }
                        decorateDefName(decorations, nextArg.substring(bump, colonIndex), lineNumber, start + i + 1 + bump);
                        i += colonIndex;
                        lastDecor = i + bump;
                        const afterColon = nextArg.substring(colonIndex);
                        for (let possible of dataActions) {
                            if (afterColon.startsWith(possible)) {
                                addDecor(decorations, "data_actions", lineNumber, start + i + 1, start + i + 1 + possible.length);
                                lastDecor = i + possible.length + 1;
                                break;
                            }
                        }
                    }
                }
            }
        }
    }
    if (lastDecor < len) {
        addDecor(decorations, defaultDecor, lineNumber, start + lastDecor, start + len);
    }
}

function indexOfAny(text : string, searches : string[], start : number) : number {
    let least : number = -1;
    for (let search of searches) {
        const thisHit = text.indexOf(search, start);
        if (thisHit != -1 && (thisHit < least || least == -1)) {
            least = thisHit;
        }
    }
    return least;
}

function decorateDefName(decorations: { [color: string]: vscode.Range[] }, part : string, lineNumber : number, start : number) {
    let dot : number = indexOfAny(part, ['.', '|'], 0);
    let lastIndex : number = 0;
    while (dot != -1) {
        addDecor(decorations, "def_name", lineNumber, start + lastIndex, start + dot);
        addDecor(decorations, "tag_dot", lineNumber, start + dot - 1, start + dot + 1);
        lastIndex = dot + 1;
        dot = indexOfAny(part, ['.', '|'], dot + 1);
    }
    addDecor(decorations, "def_name", lineNumber, start + lastIndex, start + part.length);
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
    "interact scripts", "default constants", "data", "constants", "text", "lore", "aliases", "slots", "enchantments", "input", "description"
];

function decorateLine(line : string, lineNumber: number, decorations: { [color: string]: vscode.Range[] }, lastKey : string, isData : boolean) {
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
        const isNonScript : boolean = isData;
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
        if (trimmed.startsWith("on ") || trimmed.startsWith("after ")) {
            decorateEventLine(trimmed.substring(0, trimmed.length - 1), preSpaces, lineNumber, decorations);
        }
        else {
            decorateSpaceable(trimmed.substring(0, trimmed.length - 1), preSpaces, lineNumber, "key", decorations);
        }
        addDecor(decorations, "colons", lineNumber, trimmedEnd.length - 1, trimmedEnd.length);
    }
    else if (trimmed.includes(": ")) {
        const colonIndex = line.indexOf(": ");
        const key = trimmed.substring(0, colonIndex - preSpaces);
        decorateSpaceable(key, preSpaces, lineNumber, "key_inline", decorations);
        addDecor(decorations, "colons", lineNumber, colonIndex, colonIndex + 1);
        addDecor(decorations, "space", lineNumber, colonIndex + 1, colonIndex + 2);
        if (key == "definitions") {
            decorateDefinitionsKey(trimmed.substring(colonIndex - preSpaces + 2), colonIndex + 2, lineNumber, decorations);
        }
        else {
            decorateArg(trimmed.substring(colonIndex - preSpaces + 2), colonIndex + 2, lineNumber, decorations, false, "key:" + key);
        }
    }
    else {
        addDecor(decorations, "bad_space", lineNumber, preSpaces, line.length);
    }
}

function decorateDefinitionsKey(arg : string, start: number, lineNumber: number, decorations: { [color: string]: vscode.Range[] }) {
    const len : number = arg.length;
    let lastDecor = 0;
    let textColor = "def_name";
    for (let i = 0; i < len; i++) {
        const c : string = arg.charAt(i);
        if (c == '[') {
            addDecor(decorations, textColor, lineNumber, start + lastDecor, start + i);
            addDecor(decorations, "tag_param_bracket", lineNumber, start + i, start + i + 1);
            textColor = "tag_param";
            lastDecor = i + 1;
        }
        else if (c == ']') {
            addDecor(decorations, textColor, lineNumber, start + lastDecor, start + i);
            addDecor(decorations, "tag_param_bracket", lineNumber, start + i, start + i + 1);
            textColor = "bad_space";
            lastDecor = i + 1;
        }
        else if (c == ' ') {
            addDecor(decorations, textColor, lineNumber, start + lastDecor, start + i);
            addDecor(decorations, "space", lineNumber, start + i, start + i + 1);
            lastDecor = i + 1;
        }
        else if (c == '|') {
            addDecor(decorations, textColor, lineNumber, start + lastDecor, start + i);
            addDecor(decorations, "normal", lineNumber, start + i, start + i + 1);
            textColor = "def_name";
            lastDecor = i + 1;
        }
    }
    if (lastDecor < len - 1) {
        addDecor(decorations, textColor, lineNumber, start + lastDecor, start + len);
    }
}

function decorateEventLine(line : string, preLength: number, lineNumber: number, decorations: { [color: string]: vscode.Range[] }) {
    let charIndex : number = 0;
    for (let arg of line.split(' ')) {
        let format = "event_line";
        if (charIndex == 0 && (arg == 'on' || arg == 'after')) {
            format = "key";
        }
        if (charIndex > 0) {
            addDecor(decorations, "space", lineNumber, preLength + charIndex - 1, preLength + charIndex);
        }
        const colon = arg.indexOf(':');
        if (colon != -1) {
            addDecor(decorations, "event_switch", lineNumber, preLength + charIndex, preLength + charIndex + colon);
            addDecor(decorations, "colons", lineNumber, preLength + charIndex + colon, preLength + charIndex + colon + 1);
            addDecor(decorations, "event_switch_value", lineNumber, preLength + charIndex + colon + 1, preLength + charIndex + arg.length);
        }
        else {
            addDecor(decorations, format, lineNumber, preLength + charIndex, preLength + charIndex + arg.length);
        }
        charIndex += arg.length + 1;
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
    let definitelyDataSpacing : number = -1;
    // Actually choose colors
    for (let i : number = 0; i < endLine; i++) {
        const lineText : string = splitText[i];
        const trimmedLineStart : string = lineText.trimStart();
        const spaces : number = lineText.length - trimmedLineStart.length;
        const trimmedLine : string = trimmedLineStart.trimEnd();
        if (trimmedLine.endsWith(":") && !trimmedLine.startsWith("-")) {
            lastKey = trimmedLine.substring(0, trimmedLine.length - 1).toLowerCase();
            if (spaces <= definitelyDataSpacing) {
                definitelyDataSpacing = -1;
            }
            if (definiteNotScriptKeys.includes(lastKey) && definitelyDataSpacing == -1) {
                definitelyDataSpacing = spaces;
            }
        }
        else if (trimmedLine == "type: data" && (definitelyDataSpacing == -1 || spaces <= definitelyDataSpacing)) {
            definitelyDataSpacing = spaces - 1;
        }
        if (spaces < definitelyDataSpacing) {
            definitelyDataSpacing = -1;
        }
        if (i >= startLine) {
            decorateLine(lineText, i, decorations, lastKey, definitelyDataSpacing != -1);
        }
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

let changeCounter : number = 0;

let hasLoadedConfig : boolean = false;
let searchedPathsForConfig : string[] = [];
let configColors : { [name : string] : string } = {};

function applyConfigColors() {
    for (const name in configColors) {
        const val : string = configColors[name];
        let color = "";
        if (val.startsWith("<") && val.endsWith(">")) {
            for (const tag of val.slice(1, -1).split("><")) {
                const newColor : string = getTagColor(tag, color);
                if (newColor) {
                    color = newColor;
                }
            }
        }
        if (color != "") {
            tagSpecialColors["&[" + name + "]"] = color;
        }
    }
}

function tryLoadConfigYaml(relativeTo : vscode.TextDocument) {
    if (hasLoadedConfig) {
        return;
    }
    try {
        const parts : string[] = relativeTo.fileName.replaceAll('\\', '/').split('/').slice(0, -1);
        for (let i : number = parts.length; i >= 1; i--) {
            const subPath : string = parts.slice(0, i).join('/') + '/' + "config.yml";
            if (subPath in searchedPathsForConfig) {
                return;
            }
            searchedPathsForConfig.push(subPath);
            if (fs.existsSync(subPath)) {
                const content : string = fs.readFileSync(subPath, { encoding: 'utf-8', flag: 'r' });
                const lines : string[] = content.replaceAll('\r', '').split('\n');
                let isReadingColors : boolean = false;
                for (const line of lines) {
                    const trimmed : string = line.trim();
                    if (trimmed == "" || trimmed.startsWith("#")) {
                        continue;
                    }
                    if (line == "Colors:") {
                        outputChannel.appendLine("Path " + subPath + " had a valid config.yml! Loading custom colors from it.");
                        hasLoadedConfig = true;
                        isReadingColors = true;
                        continue;
                    }
                    if (isReadingColors) {
                        if (!line.startsWith("  ")) {
                            isReadingColors = false;
                            break;
                        }
                        const colon : number = trimmed.indexOf(': ');
                        if (colon != -1) {
                            const name : string = trimmed.substring(0, colon);
                            const colorData : string = trimmed.substring(colon + 2);
                            configColors[name.toLowerCase()] = colorData.toLowerCase();
                        }
                    }
                }
            }
            if (hasLoadedConfig) {
                applyConfigColors();
                return;
            }
        }
    }
    catch (err) {
        outputChannel.appendLine("Failed while trying to read a config file: " + err);
    }
}

export async function activate(context: vscode.ExtensionContext) {
    let path : string = await activateDotNet();
    activateLanguageServer(context, path);
    activateHighlighter(context);
    vscode.workspace.onDidOpenTextDocument(doc => {
        if (doc.uri.toString().endsWith(".dsc")) {
            tryLoadConfigYaml(doc);
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
            if (changeCounter++ < 2) {
                forceRefresh("onDidChangeTextDocument" + changeCounter);
            }
        }
    }, null, context.subscriptions);
    vscode.window.onDidChangeVisibleTextEditors(editors => {
        for (const editor of editors) {
            const uri = editor.document.uri.toString();
            if (!uri.endsWith(".dsc")) {
                continue;
            }
            tryLoadConfigYaml(editor.document);
            forceRefresh("onDidChangeVisibleTextEditors");
            return;
        }
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
