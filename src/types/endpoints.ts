export interface IServerAPIRouter<R = unknown> {
    endpoint: string;
    router: R;
}
