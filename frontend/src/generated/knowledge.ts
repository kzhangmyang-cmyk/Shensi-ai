export interface paths {
    "/api/v1/knowledge/availability": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["knowledgeAvailability"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/knowledge/documents": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["listKnowledgeDocuments"];
        put?: never;
        post: operations["createKnowledgeDocument"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/knowledge/documents/{id}": {
        parameters: {
            query?: never;
            header: {
                "X-Workspace-Id": components["parameters"]["workspace"];
            };
            path: {
                id: components["parameters"]["id"];
            };
            cookie?: never;
        };
        get: operations["getKnowledgeDocument"];
        put?: never;
        post?: never;
        delete: operations["deleteKnowledgeDocument"];
        options?: never;
        head?: never;
        patch: operations["updateKnowledgeDocument"];
        trace?: never;
    };
    "/api/v1/knowledge/documents/{id}/versions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["replaceKnowledgeDocument"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/knowledge/documents/{id}/versions/{versionId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getKnowledgeVersion"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/knowledge/documents/{id}/versions/{versionId}/content": {
        parameters: {
            query?: never;
            header: {
                "X-Workspace-Id": components["parameters"]["workspace"];
            };
            path: {
                id: components["parameters"]["id"];
                versionId: components["parameters"]["versionId"];
            };
            cookie?: never;
        };
        get: operations["downloadKnowledgeOriginal"];
        put: operations["uploadKnowledgeOriginal"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/knowledge/documents/{id}/versions/{versionId}/chunks": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["previewKnowledgeChunks"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/knowledge/documents/{id}/versions/{versionId}/retry": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["retryKnowledgeIngestion"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/knowledge/jobs/{jobId}/cancel": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["cancelKnowledgeIngestion"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: {
        KnowledgeUploadInput: components["schemas"]["UploadInput"];
        KnowledgePatch: components["schemas"]["Patch"];
        KnowledgeRole: components["schemas"]["Role"];
        KnowledgeStatus: components["schemas"]["Status"];
        KnowledgeDocument: components["schemas"]["Document"];
        KnowledgeVersion: components["schemas"]["Version"];
        KnowledgeChunk: components["schemas"]["Chunk"];
        KnowledgeCitation: components["schemas"]["Citation"];
        ReferenceCitation: components["schemas"]["Citation"] | components["schemas"]["SystemReference"];
        LibraryStatus: {
            /** @enum {unknown} */
            private: "off" | "used" | "no_match" | "unavailable";
            /** @enum {unknown} */
            system: "off" | "unconfigured" | "unbound" | "ready" | "no_match" | "unavailable" | "auth_required" | "forbidden" | "rate_limited" | "vocabulary_mismatch";
        };
        KnowledgeAnswer: components["schemas"]["Answer"];
        KnowledgeError: {
            error: {
                code: string;
                message: string;
            };
        };
        KnowledgeCreated: {
            document: components["schemas"]["Document"];
            version: components["schemas"]["Version"];
        };
        KnowledgeDocumentList: {
            items: components["schemas"]["Document"][];
            nextCursor: string | null;
        };
        KnowledgeChunkList: {
            items: components["schemas"]["Chunk"][];
            nextCursor: string | null;
        };
        KnowledgeAvailability: {
            available: boolean;
            reason: string | null;
        };
        /** @enum {unknown} */
        Role: "cfo" | "finance" | "profit" | "cost" | "cashflow" | "tax";
        /** @enum {unknown} */
        Status: "queued" | "parsing" | "indexing" | "ready" | "failed" | "cancelled";
        Roles: components["schemas"]["Role"][];
        Document: {
            /** Format: uuid */
            id: string;
            revision: number;
            title: string;
            /** @enum {unknown} */
            sourceKind: "book" | "company" | "reference";
            roles: components["schemas"]["Roles"];
            enabled: boolean;
            /** Format: uuid */
            activeVersionId: string | null;
            /** Format: uuid */
            latestVersionId: string;
            /** Format: date-time */
            updatedAt: string;
        };
        UploadInput: {
            title: string;
            filename: string;
            /** @enum {unknown} */
            format: "pdf" | "docx" | "xlsx" | "csv" | "txt" | "md";
            bytes: number;
            /** @enum {unknown} */
            sourceKind: "book" | "company" | "reference";
            roles: components["schemas"]["Roles"];
        } & unknown;
        Coverage: {
            totalPages: number | null;
            extractedPages: number | null;
            missingPages: number[];
        };
        Warnings: string[];
        Version: {
            /** Format: uuid */
            id: string;
            /** Format: uuid */
            documentId: string;
            revision: number;
            /** Format: uuid */
            jobId: string | null;
            filename: string;
            /** @enum {unknown} */
            format: "pdf" | "docx" | "xlsx" | "csv" | "txt" | "md";
            bytes: number;
            sourceHash: string | null;
            uploadComplete: boolean;
            status: components["schemas"]["Status"];
            coverage: null | components["schemas"]["Coverage"];
            warnings: components["schemas"]["Warnings"];
            failureCode: string | null;
        };
        Patch: {
            title?: string;
            /** @enum {unknown} */
            sourceKind?: "book" | "company" | "reference";
            roles?: components["schemas"]["Roles"];
            enabled?: boolean;
        };
        Locator: {
            page?: number;
            chapter?: string;
            sheet?: string;
            row?: number;
            column?: number;
            paragraph?: number;
            table?: number;
            startLine?: number;
            endLine?: number;
            startOffset?: number;
            endOffset?: number;
        };
        Chunk: {
            /** Format: uuid */
            id: string;
            /** Format: uuid */
            versionId: string;
            order: number;
            text: string;
            locator: components["schemas"]["Locator"];
            warnings: components["schemas"]["Warnings"];
        };
        Citation: {
            /**
             * @description Omitted is legacy private; never infer system ownership from UUID or K alias.
             * @constant
             */
            sourceType?: "private";
            sourceId: string;
            /** Format: uuid */
            documentId: string;
            /** Format: uuid */
            versionId: string;
            sourceHash: string;
            /** Format: uuid */
            chunkId: string;
            sourceLabel: string;
            locator: components["schemas"]["Locator"];
            excerpt: string;
            warnings: components["schemas"]["Warnings"];
        };
        /** @description Server-selected UTF-16 half-open offsets in the immutable chunk. Runtime also checks exact length/source equality and intact surrogate pairs. */
        ExcerptRange: {
            start: number;
            end: number;
        };
        SystemReference: {
            /** @constant */
            sourceType: "system";
            sourceId: string;
            referenceKey: string;
            /** Format: uuid */
            queryGrantId: string;
            /** Format: uuid */
            referenceId: string;
            /** Format: uuid */
            corpusId: string;
            /** Format: uuid */
            releaseId: string;
            sourceHash: string;
            chunkHash: string;
            excerptRange: components["schemas"]["ExcerptRange"];
            sourceLabel: string;
            locator: components["schemas"]["Locator"];
            excerpt: string;
            warnings: components["schemas"]["Warnings"];
        };
        Answer: {
            /** @enum {unknown} */
            status: "used" | "no_match" | "unavailable";
            detailedText: string;
            sources: components["schemas"]["ReferenceCitation"][];
            warnings: components["schemas"]["Warnings"];
        };
    };
    responses: {
        /** @description Bounded code/message without plaintext, private paths or ownership. */
        error: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["KnowledgeError"];
            };
        };
        /** @description Current document metadata. */
        document: {
            headers: {
                ETag?: string;
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["Document"];
            };
        };
        /** @description Version state; uploaded does not mean ready. */
        version: {
            headers: {
                ETag?: string;
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["Version"];
            };
        };
    };
    parameters: {
        workspace: string;
        /** @description Required for cookie-authenticated writes. */
        csrf: string;
        key: string;
        /** @description Document revision for metadata/replacement; version revision for content/retry. */
        revision: string;
        id: string;
        versionId: string;
        jobId: string;
        cursor: string;
        limit: number;
    };
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
    knowledgeAvailability: {
        parameters: {
            query?: never;
            header: {
                "X-Workspace-Id": components["parameters"]["workspace"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Configuration availability */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["KnowledgeAvailability"];
                };
            };
            default: components["responses"]["error"];
        };
    };
    listKnowledgeDocuments: {
        parameters: {
            query?: {
                cursor?: components["parameters"]["cursor"];
                limit?: components["parameters"]["limit"];
                q?: string;
                role?: components["schemas"]["Role"];
                status?: components["schemas"]["Status"];
            };
            header: {
                "X-Workspace-Id": components["parameters"]["workspace"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Actor-private page */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["KnowledgeDocumentList"];
                };
            };
            default: components["responses"]["error"];
        };
    };
    createKnowledgeDocument: {
        parameters: {
            query?: never;
            header: {
                "X-Workspace-Id": components["parameters"]["workspace"];
                /** @description Required for cookie-authenticated writes. */
                "X-CSRF-Token"?: components["parameters"]["csrf"];
                "Idempotency-Key": components["parameters"]["key"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["UploadInput"];
            };
        };
        responses: {
            /** @description Metadata only; separate original upload */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["KnowledgeCreated"];
                };
            };
            default: components["responses"]["error"];
        };
    };
    getKnowledgeDocument: {
        parameters: {
            query?: never;
            header: {
                "X-Workspace-Id": components["parameters"]["workspace"];
            };
            path: {
                id: components["parameters"]["id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["document"];
            default: components["responses"]["error"];
        };
    };
    deleteKnowledgeDocument: {
        parameters: {
            query?: never;
            header: {
                "X-Workspace-Id": components["parameters"]["workspace"];
                /** @description Required for cookie-authenticated writes. */
                "X-CSRF-Token"?: components["parameters"]["csrf"];
                "Idempotency-Key": components["parameters"]["key"];
                /** @description Document revision for metadata/replacement; version revision for content/retry. */
                "If-Match": components["parameters"]["revision"];
            };
            path: {
                id: components["parameters"]["id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Access revoked; owned cleanup scheduled */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            default: components["responses"]["error"];
        };
    };
    updateKnowledgeDocument: {
        parameters: {
            query?: never;
            header: {
                "X-Workspace-Id": components["parameters"]["workspace"];
                /** @description Required for cookie-authenticated writes. */
                "X-CSRF-Token"?: components["parameters"]["csrf"];
                "Idempotency-Key": components["parameters"]["key"];
                /** @description Document revision for metadata/replacement; version revision for content/retry. */
                "If-Match": components["parameters"]["revision"];
            };
            path: {
                id: components["parameters"]["id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["Patch"];
            };
        };
        responses: {
            200: components["responses"]["document"];
            default: components["responses"]["error"];
        };
    };
    replaceKnowledgeDocument: {
        parameters: {
            query?: never;
            header: {
                "X-Workspace-Id": components["parameters"]["workspace"];
                /** @description Required for cookie-authenticated writes. */
                "X-CSRF-Token"?: components["parameters"]["csrf"];
                "Idempotency-Key": components["parameters"]["key"];
                /** @description Document revision for metadata/replacement; version revision for content/retry. */
                "If-Match": components["parameters"]["revision"];
            };
            path: {
                id: components["parameters"]["id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["UploadInput"];
            };
        };
        responses: {
            201: components["responses"]["version"];
            default: components["responses"]["error"];
        };
    };
    getKnowledgeVersion: {
        parameters: {
            query?: never;
            header: {
                "X-Workspace-Id": components["parameters"]["workspace"];
            };
            path: {
                id: components["parameters"]["id"];
                versionId: components["parameters"]["versionId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["version"];
            default: components["responses"]["error"];
        };
    };
    downloadKnowledgeOriginal: {
        parameters: {
            query?: never;
            header: {
                "X-Workspace-Id": components["parameters"]["workspace"];
            };
            path: {
                id: components["parameters"]["id"];
                versionId: components["parameters"]["versionId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Authorized original */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/octet-stream": string;
                };
            };
            default: components["responses"]["error"];
        };
    };
    uploadKnowledgeOriginal: {
        parameters: {
            query?: never;
            header: {
                "X-Workspace-Id": components["parameters"]["workspace"];
                /** @description Required for cookie-authenticated writes. */
                "X-CSRF-Token"?: components["parameters"]["csrf"];
                "Idempotency-Key": components["parameters"]["key"];
                /** @description Document revision for metadata/replacement; version revision for content/retry. */
                "If-Match": components["parameters"]["revision"];
            };
            path: {
                id: components["parameters"]["id"];
                versionId: components["parameters"]["versionId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/octet-stream": string;
            };
        };
        responses: {
            200: components["responses"]["version"];
            default: components["responses"]["error"];
        };
    };
    previewKnowledgeChunks: {
        parameters: {
            query?: {
                cursor?: components["parameters"]["cursor"];
                limit?: components["parameters"]["limit"];
            };
            header: {
                "X-Workspace-Id": components["parameters"]["workspace"];
            };
            path: {
                id: components["parameters"]["id"];
                versionId: components["parameters"]["versionId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Authorized bounded preview */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["KnowledgeChunkList"];
                };
            };
            default: components["responses"]["error"];
        };
    };
    retryKnowledgeIngestion: {
        parameters: {
            query?: never;
            header: {
                "X-Workspace-Id": components["parameters"]["workspace"];
                /** @description Required for cookie-authenticated writes. */
                "X-CSRF-Token"?: components["parameters"]["csrf"];
                "Idempotency-Key": components["parameters"]["key"];
                /** @description Document revision for metadata/replacement; version revision for content/retry. */
                "If-Match": components["parameters"]["revision"];
            };
            path: {
                id: components["parameters"]["id"];
                versionId: components["parameters"]["versionId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["version"];
            default: components["responses"]["error"];
        };
    };
    cancelKnowledgeIngestion: {
        parameters: {
            query?: never;
            header: {
                "X-Workspace-Id": components["parameters"]["workspace"];
                /** @description Required for cookie-authenticated writes. */
                "X-CSRF-Token"?: components["parameters"]["csrf"];
            };
            path: {
                jobId: components["parameters"]["jobId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Cancel exact owned job */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            default: components["responses"]["error"];
        };
    };
}
