export interface IInitializeRequest {
    type: "initialize";
}

export interface IUpdateRequest {
    type: "success";
    image: string;
    mods: any;
    mod: string;
}

export interface IErrorRequest {
    type: "failure";
    message: string;
}

export interface ISerializeRequest {
    type: "serialize";
}

export interface ISerializeResponse {
    type: "serializeResponse";
    result: any;
}

export interface IRestoreRequest {
    type: "restore";
    archive: any;
}

export type PreviewRequest = IInitializeRequest | IUpdateRequest | IErrorRequest | ISerializeRequest | IRestoreRequest;
export type PreviewResponse = ISerializeResponse | undefined;

export interface IExportRequest {
    type: "export";
    image: string;
}

export interface IModRequest {
    type: "mod";
    mod: string;
}

export type ExtensionRequest = IExportRequest | IModRequest;
export type ExtensionResponse = void;
