import * as path from "path";
import * as vscode from "vscode";
import * as engines from "./engines";
import { ExtensionRequest, ExtensionResponse, PreviewRequest, PreviewResponse } from "./messages";
import { createMessenger, IMessagePort, IReceiveMessage, ISendMessage } from "./messenger";
import { createScheduler } from "./scheduler";
import * as utilities from "./utilities";

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

export class PreviewManager {
    private readonly previewDirUri: vscode.Uri;
    private readonly previewContent: string;
    private readonly previewContexts = new WeakMap<vscode.TextDocument, IPreviewContext>();
    private mod = ALL_MODS;
    private graphText = "";
    private Graph = require("@dagrejs/graphlib").Graph;
    private g = new this.Graph({ multigraph: true });

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
        this.mod = mod;
        await this.updateGraphText();
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

    private async updateGraphText(): Promise<void> {
        let graphText = "digraph G{\n";
        if (this.mod === ALL_MODS) {
            const mods = this.g.nodes();
            if (mods.length > 200) {
                vscode.window.showInformationMessage("The size of dependency mods is more than 200, so please check ONE of them.");
            } else {
                const edges = this.g.edges();
                for (const edge of edges) {
                    graphText += `"${edge.v}" -> "${edge.w}" ${edge.name}\n`;
                }
            }
        } else {;
            let froms = [];
            let used = new Set();
            froms.push(this.mod);
            used.add(this.mod);
            while (froms.length > 0) {
                const to: string = froms.pop()
                // const edgeS = this.g.outEdges(to);
                const ine = this.g.inEdges(to);
                // const all = this.g.nodeEdges(to);
                for (const edge of ine) {
                    graphText += `"${edge.v}" -> "${edge.w}" ${edge.name}\n`;
                    if (!used.has(edge.v)) {
                        froms.push(edge.v);
                        used.add(edge.v);
                    }
                }
            }
            used = new Set([]);
        }
        graphText += "}";
        this.graphText = graphText;
    }

    private async goModGraph(dir: string):  Promise<void> {
        try {
            const [exitCode, stdout, stderr] = await utilities.runChildProcess(
                "go",
                ["mod", "graph"],
                dir,
                "",
                undefined
            );
            if (exitCode !== 0) {
                throw new Error(stderr.trim());
            }

            // console.log('stdout: ' + stdout);
            // console.log('stderr: ' + stderr);

            const splitted = stdout.split("\n");
            splitted.forEach(li => {
                if (li && li.includes(" ") && li.includes("@") && !li.includes(":")) {
                    // console.log("for loop mod graph: " + li)
                    const mods = li.split(" ");
                    let from = mods[0];
                    let fromV = "Current";
                    if (from.indexOf("@") >= 0) {
                        const froms = mods[0].split("@");
                        from = froms[0];
                        fromV = froms[1];
                    }
                    const tos = mods[1].split("@");
                    const to = tos[0];
                    const toV = tos[1];

                    const edge = `[label="${fromV} -> ${toV}"]`;
                    this.g.setEdge(from, to, edge, edge); // from, to, label, name
                }
            });
        } catch (error) {
            if (error.code === "ENOENT") {
                vscode.window.showErrorMessage("Need run 'go mod graph' first.");
            } else {
                throw error;
            }
        }
    }

    private async createPreview(document: vscode.TextDocument, column: vscode.ViewColumn): Promise<IPreviewContext> {
        const documentDir = path.dirname(document.fileName);
        const documentDirUri = vscode.Uri.file(documentDir);
        const localResourceRoots = [this.previewDirUri, documentDirUri];

        if (vscode.workspace.workspaceFolders) {
            localResourceRoots.push(...vscode.workspace.workspaceFolders.map((f) => f.uri));
        }

        // TODO need proper progress message
        vscode.window.setStatusBarMessage("> Running 'go mod graph'...", 1000 * 10);
        await this.goModGraph(documentDir);
        await this.updateGraphText();
        let mods = this.g.nodes();
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
                            // console.log("------update mod--:", message.mod);
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
        vscode.window.setStatusBarMessage(">> Rendering all mods graph...", 1000 * 10);
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
