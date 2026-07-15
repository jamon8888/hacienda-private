declare module "edgevec" {
  export function init(): Promise<void>;
  export interface EdgeVecOptions {
    [key: string]: unknown;
  }
  export class EdgeVec {
    constructor(opts?: EdgeVecOptions);
    loadFromSerialized(data: Uint8Array | ArrayBuffer): Promise<void>;
    search(...args: unknown[]): Promise<unknown>;
  }
}
