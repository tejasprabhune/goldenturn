export interface CompileOutput {
    rawHtml: string;
    deps: string[];
}
export declare function compileTypst(source: string, filePath?: string, autoPreamble?: boolean): Promise<CompileOutput>;
//# sourceMappingURL=compile.d.ts.map