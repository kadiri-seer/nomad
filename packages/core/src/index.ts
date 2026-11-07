export * from "./ids";
export * from "./hash";
export * from "./adapter";
export * from "./markdown";
export * from "./document";
export * from "./merge";

export const NOMAD_VERSION = "0.1.1";

export class NomadError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly hint?: string
  ) {
    super(message);
    this.name = "NomadError";
  }
}
