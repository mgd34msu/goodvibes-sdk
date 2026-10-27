import { z } from 'zod';
declare const ReplacementSchema: z.ZodObject<{
    precedence: z.ZodNumber;
    line: z.ZodNumber;
    endLine: z.ZodNumber;
    column: z.ZodNumber;
    endColumn: z.ZodNumber;
    insertionPoint: z.ZodString;
    replacement: z.ZodString;
}, z.core.$strip>;
declare const LevelSchema: z.ZodEnum<{
    error: "error";
    info: "info";
    warning: "warning";
    style: "style";
}>;
export declare const ShellCheckResultSchema: z.ZodObject<{
    comments: z.ZodArray<z.ZodObject<{
        file: z.ZodString;
        line: z.ZodNumber;
        endLine: z.ZodNumber;
        column: z.ZodNumber;
        endColumn: z.ZodNumber;
        level: z.ZodEnum<{
            error: "error";
            info: "info";
            warning: "warning";
            style: "style";
        }>;
        code: z.ZodNumber;
        message: z.ZodString;
        fix: z.ZodNullable<z.ZodObject<{
            replacements: z.ZodArray<z.ZodObject<{
                precedence: z.ZodNumber;
                line: z.ZodNumber;
                endLine: z.ZodNumber;
                column: z.ZodNumber;
                endColumn: z.ZodNumber;
                insertionPoint: z.ZodString;
                replacement: z.ZodString;
            }, z.core.$strip>>;
        }, z.core.$strip>>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export type ShellCheckResult = z.infer<typeof ShellCheckResultSchema>;
export type ShellCheckComment = ShellCheckResult['comments'][number];
export type ShellCheckCommentLevel = z.infer<typeof LevelSchema>;
export type ShellCheckReplacement = z.infer<typeof ReplacementSchema>;
export {};
