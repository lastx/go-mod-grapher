import * as child from "child_process";
import * as path from "path";
import * as vscode from "vscode";
import * as engines from "./engines";
import { ExtensionRequest, ExtensionResponse, PreviewRequest, PreviewResponse } from "./messages";
import { createMessenger, IMessagePort, IReceiveMessage, ISendMessage } from "./messenger";
import { createScheduler } from "./scheduler";

const previewType = "graphviz.preview";
const ALL_MODS = "all_mods";

class PreviewPort implements
    IMessagePort<ISendMessage<PreviewRequest, ExtensionResponse>, IReceiveMessage<PreviewResponse, ExtensionRequest>> {
    public constructor(private readonly view: vscode.Webview) {
    }

    public send(message: ISendMessage<PreviewRequest, ExtensionResponse>): void {
        this.view.postMessage(message);
    }

    public onReceive(handler: (message: IReceiveMessage<PreviewResponse, ExtensionRequest>) => void): void {
        this.view.onDidReceiveMessage(handler);
    }
}

function uriToVscodeResource(uri: vscode.Uri): string {
    return uri.with({ scheme: "vscode-resource" }).toString(true);
}

interface IPreviewContext {
    readonly webviewPanel: vscode.WebviewPanel;
    readonly updatePreview: () => void;
}

interface IGraphData {
    readonly graphText: string;
    readonly toSet: Map<string, Set<string>>;
    readonly mapSet: Map<string, string>;
}

export class PreviewManager {
    private readonly previewDirUri: vscode.Uri;
    private readonly previewContent: string;
    private readonly previewContexts = new WeakMap<vscode.TextDocument, IPreviewContext>();
    private toSet = new Map();
    private mapSet = new Map();
    private graphText = "";
    private mod = ALL_MODS;

    public constructor(context: vscode.ExtensionContext, template: string) {
        this.previewDirUri = vscode.Uri.file(context.asAbsolutePath("out/preview"));
        this.previewContent = template.replace(/\{preview-dir\}/g, uriToVscodeResource(this.previewDirUri));
    }

    public async showGrapherToSide(editor: vscode.TextEditor): Promise<void> {
        const document = editor.document;
        const context = this.previewContexts.get(document);

        if (context === undefined) {
            this.previewContexts.set(document, await this.createPreview(document, vscode.ViewColumn.Beside));
        } else {
            context.webviewPanel.reveal(undefined, true);
        }
    }

    public async updatePreview(document: vscode.TextDocument): Promise<void> {
        const context = this.previewContexts.get(document);

        if (context !== undefined) {
            context.updatePreview();
        }
    }

    private async updateModPreview(document: vscode.TextDocument, mod: string): Promise<void> {
        const context = this.previewContexts.get(document);

        let graphText = "digraph G{\n";
        let gSet = new Set();
        if (mod === ALL_MODS) {
            this.mapSet.forEach((value) => {
                let tmpA = new Set();
                tmpA = value;
                if (tmpA) {
                    tmpA.forEach(el => {
                        gSet.add(el);
                    });
                }
            });
        } else {
            let froms = [];
            froms.push(mod);
            while (froms.length > 0) {
                const to = froms.pop();
                let tmp1 = new Set();
                tmp1 = this.toSet.get(to);
                if (tmp1) {
                    tmp1.forEach(el => {
                        froms.push(el);
                    });
                }
                let tmp2 = new Set();
                tmp2 = this.mapSet.get(to);
                if (tmp2) {
                    tmp2.forEach(ele => {
                        gSet.add(ele);
                    });
                }
            }
        }
        if (gSet.size > 0) {
            gSet.forEach(el => {
                graphText +=  el;
            });
        }
        graphText += "}";
        this.graphText = graphText;

        this.mod = mod;
        if (context !== undefined) {
            context.updatePreview();
        }
    }

    private async exportImage(
        source: string,
        svgContent: string,
        workingDir: string
    ): Promise<void> {
        const filePath = await vscode.window.showSaveDialog({
            filters: { "PDF": ["pdf"], "PNG Image": ["png"], "SVG Image": ["svg"] }
        });

        if (filePath) {
            await engines.currentEngine.saveToFile(source, svgContent, filePath.fsPath, workingDir);
        }
    }

    private async goModGraph(dir: string):  Promise<IGraphData> {
        return new Promise((resolve, reject) => {
            child.exec("go mod graph", {cwd: dir}, (error, stdout, stderr) => {
              if (error) {
                vscode.window.showErrorMessage("Need run 'go mod graph' first.");
                return reject(error);
              }
              if (stderr) {
                vscode.window.showErrorMessage("Need run 'go mod graph' first.");
                return reject(stderr);
              }

              // console.log('stdout: ' + stdout);
              // console.log('stderr: ' + stderr);

              let graphText = "digraph G{\n";
              let splitted = stdout.split("\n");
              let toSet = new Map();
              let mapSet = new Map();
              splitted.forEach(li => {
                  if (li && li.includes(" ") && li.includes("@") && !li.includes(":")) {
                    //console.log("for loop mod graph: " + li)
                    let mods = li.split(" ");
                    let from = mods[0];
                    let fromV = "Current";
                    if (from.indexOf("@") >= 0) {
                        let froms = mods[0].split("@");
                        from = froms[0];
                        fromV = froms[1];
                    }
                    let tos = mods[1].split("@");
                    let to = tos[0];
                    let toV = tos[1];

                    const newGraph = "\"" + from + "\"" + " -> " + "\"" + to + "\" [label" +
                                    "=\"" + fromV + " -> " + toV + "\"]\n";
                    graphText += newGraph;
                    if (!mapSet.has(to)) {
                        let texts = new Set();
                        texts.add(newGraph);
                        mapSet.set(to, texts);
                    } else {
                        let texts = mapSet.get(to);
                        texts.add(newGraph);
                        mapSet.set(to, texts);
                    }
                    if (toSet.has(to)) {
                        let pres = toSet.get(to);
                        pres.add(from);
                        toSet.set(to, pres);
                    } else {
                        let pres = new Set();
                        pres.add(from);
                        toSet.set(to, pres);
                    }
                }
              });
              graphText += "}";
              resolve({graphText, toSet, mapSet});
            });
          });
    }

    private async createPreview(document: vscode.TextDocument, column: vscode.ViewColumn): Promise<IPreviewContext> {
        const documentDir = path.dirname(document.fileName);
        const documentDirUri = vscode.Uri.file(documentDir);
        const localResourceRoots = [this.previewDirUri, documentDirUri];

        if (vscode.workspace.workspaceFolders) {
            localResourceRoots.push(...vscode.workspace.workspaceFolders.map((f) => f.uri));
        }

        // TODO need proper progress message
        vscode.window.setStatusBarMessage("> Running 'go mod graph'...", 1000 * 10)
        const {graphText, toSet, mapSet} = await this.goModGraph(documentDir);
        this.graphText = graphText;
        this.toSet = toSet;
        this.mapSet = mapSet;
        let mods = [...this.toSet.keys()];
        mods.push(this.mod);
        mods.sort();

        const webviewPanel = vscode.window.createWebviewPanel(
            previewType,
            `Go mod graph: ${path.basename(document.fileName)}`,
            {
                preserveFocus: true,
                viewColumn: column
            },
            {
                enableScripts: true,
                localResourceRoots,
                retainContextWhenHidden: true
            }
        );

        webviewPanel.webview.html = this.previewContent.replace(
            /\{base-url\}/g,
            uriToVscodeResource(documentDirUri)
        );

        // Add bindings.

        const messenger = createMessenger(
            new PreviewPort(webviewPanel.webview),
            async (message) => {
                switch (message.type) {
                    case "export":
                        try {
                            // console.log("------export-----");
                            await this.exportImage(this.graphText, message.image, documentDir);
                        } catch (error) {
                            await vscode.window.showErrorMessage(error.message);
                        }

                        break;
                    case "mod":
                        try {
                            // console.log("------update mod-----");
                            await this.updateModPreview(document, message.mod);
                        } catch (error) {
                            await vscode.window.showErrorMessage(error.message);
                        }
                        break;
                }
            }
        );

        const scheduler = createScheduler(
            (cancel, source: string) => engines.currentEngine.renderToSvg(source, documentDir, cancel),
            (image) => messenger({
                image,
                type: "success",
                mods: mods,
                mod: this.mod
            }),
            (error: Error) => messenger({
                message: error.message,
                type: "failure"
            })
        );

        // Add event handlers.

        // TODO need proper progress message
        vscode.window.setStatusBarMessage(">> Rendering all mods graph...", 1000 * 10)
        const updatePreview = () => scheduler(this.graphText);

        webviewPanel.onDidDispose(() => this.previewContexts.delete(document));

        webviewPanel.onDidChangeViewState((e) => {
            if (e.webviewPanel.visible) {
                updatePreview();
            }
        });

        // Initialize.

        await messenger({ type: "initialize" });

        updatePreview();

        // Return context.

        return { webviewPanel, updatePreview };
    }
}
