export interface paths {
    "/api/v1/system-reference/query": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** @description Fixed topics only; 4 KiB request and 256 KiB response, 10 s deadline. Strict authority and cumulative release budgets. No retries, raw questions or fulltext pagination. */
        post: operations["querySystemReferences"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/system-reference/grants/{id}/check": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["checkSystemReferenceGrant"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/system-reference/grants/{id}/references/{referenceId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getGrantedSystemReference"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/system-reference/binding-requests": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** @description Backend-generated S256 challenge, 5 minute lifetime; 10 attempts per observed IP/minute. This does not grant access. */
        post: operations["createReferenceBindingRequest"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/system-reference/binding-requests/{id}/approve": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** @description Explicit human approval under a normal central customer session. Subject/workspace come from server authority, never the body. */
        post: operations["approveReferenceBindingRequest"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/system-reference/binding-requests/{id}/exchange": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** @description Trusted business backend only. Single transaction consumption; never proxy token to renderer. Not retried after an uncertain result. */
        post: operations["exchangeReferenceBindingProof"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/system-reference/binding-requests/{id}/cancel": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** @description Trusted backend verifier authorization; also revokes any possibly issued reader credential. */
        post: operations["cancelReferenceBindingProof"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/reference-connection": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getReferenceConnection"];
        put?: never;
        post?: never;
        delete: operations["unbindReferenceConnection"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/reference-connection/grants/{id}/references/{referenceId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** @description Normal local actor/workspace session resolves its current trusted backend binding. Only exact previously released excerpts; no reader credentials, query/body/range, pagination or original content. Ten-second end-to-end limit and 256 KiB response; no retry or version substitution. Central reader Bearer endpoint is unchanged. */
        get: operations["getConnectedSystemReference"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/reference-connection/begin": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["beginReferenceConnection"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/reference-connection/complete": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["completeReferenceConnection"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/platform/v1/system-reference/releases": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** @description Owner metadata only; real MFA, no-store, no text or original files. not_observed never authorizes an automatic retry. */
        get: operations["listReferenceReleases"];
        put?: never;
        /** @description Fresh platform owner plus actual MFA required. Schema contract only until publication module is installed; never uploads original PDFs or a customer database. */
        post: operations["stageSystemReferenceRelease"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/platform/v1/system-reference/releases/{id}/sources/{sourceHash}/pages/{pageIndex}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /** @description Exact route only: authenticate actual MFA and owner before accepting at most 2 MiB / 100 synthetic-or-authorized parsed chunks. Body identity must equal path; server validates full parsed hash and contiguous page sequence. */
        put: operations["stageSystemReferenceSourcePage"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/platform/v1/system-reference/releases/{id}/publish": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** @description Fresh owner/MFA/revision and idempotency validation; pointer and audit update in the same transaction. */
        post: operations["publishSystemReferenceRelease"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/platform/v1/system-reference/releases/{id}/revoke": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** @description Fresh owner/MFA/revision and idempotency validation; pointer and audit update in the same transaction. */
        post: operations["revokeSystemReferenceRelease"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/platform/v1/system-reference/releases/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** @description Owner metadata only; real MFA, no-store, no text or original files. not_observed never authorizes an automatic retry. */
        get: operations["inspectReferenceRelease"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/platform/v1/system-reference/commands/status": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** @description Owner metadata only; real MFA, no-store, no text or original files. not_observed never authorizes an automatic retry. */
        get: operations["inspectReferenceCommand"];
        put?: never;
        post?: never;
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
        /** @enum {unknown} */
        ReferenceTopicId: "budget_variance" | "budget_planning" | "cost_driver" | "cost_structure" | "cashflow_forecast" | "working_capital" | "profitability_analysis" | "break_even" | "statement_analysis" | "ratio_analysis" | "tax_document_review" | "tax_risk_review";
        ReferenceTopicSelection: components["schemas"]["ReferenceTopicId"][];
        ReferenceQuery: {
            /** @constant */
            vocabularyVersion: "finance-topics.v1";
            topicIds: components["schemas"]["ReferenceTopicId"][];
            role: components["schemas"]["Role"];
            /** Format: uuid */
            requestId: string;
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
        ReferenceCitation: components["schemas"]["Citation"] | components["schemas"]["SystemReference"];
        LibraryStatus: {
            /** @enum {unknown} */
            private: "off" | "used" | "no_match" | "unavailable";
            /** @enum {unknown} */
            system: "off" | "unconfigured" | "unbound" | "ready" | "no_match" | "unavailable" | "auth_required" | "forbidden" | "rate_limited" | "vocabulary_mismatch";
        };
        /** @description Trusted identity projection only. IDs use the existing central identity store's opaque string format, not client-generated UUIDs. */
        CentralReader: {
            subjectId: string;
            workspaceId: string;
            authVersion: number;
            authorityRevision: number;
        };
        CentralOwner: {
            userId: string;
            authVersion: number;
            platformRevision: number;
            sessionVersion: number;
        };
        ConnectionStatus: {
            /** @enum {unknown} */
            status: "unconfigured" | "unbound" | "pending" | "ready" | "session_ready" | "embedded_ready" | "unconfirmed" | "auth_required" | "forbidden" | "unavailable";
            generation: number;
            centralAccountLabel?: string;
            /** Format: date-time */
            expiresAt?: string;
        };
        ReleaseDraft: {
            /** Format: uuid */
            id: string;
            /** Format: uuid */
            corpusId: string;
            revision: number;
            /** @enum {unknown} */
            status: "staging" | "ready" | "published" | "revoked" | "failed";
            manifestHash: string;
        };
        PublicationManifest: {
            /** Format: uuid */
            corpusId: string;
            sources: {
                sourceHash: string;
                artifactHash: string;
                parsedHash: string;
                parserVersion: string;
                title: string;
                roles: components["schemas"]["Roles"];
                coverage: components["schemas"]["Coverage"];
                warnings: components["schemas"]["Warnings"];
            }[];
        };
        SourcePage: {
            sourceHash: string;
            pageIndex: number;
            totalChunks: number;
            chunks: {
                order: number;
                text: string;
                locator: components["schemas"]["Locator"];
                warnings: components["schemas"]["Warnings"];
            }[];
        };
        QueryResult: {
            /** @constant */
            status: "used";
            /** Format: uuid */
            grantId: string;
            /** Format: uuid */
            releaseId: string;
            sources: components["schemas"]["SystemReference"][];
        } | {
            /** @enum {unknown} */
            status: "no_match" | "rate_limited";
            /** Format: uuid */
            releaseId?: string;
            sources: components["schemas"]["SystemReference"][];
        };
        BindingCreate: {
            challenge: string;
        };
        BindingPending: {
            /** Format: uuid */
            requestId: string;
            displayCode: string;
            /** Format: date-time */
            expiresAt: string;
        };
        BindingApprove: {
            displayCode: string;
        };
        BindingProof: {
            verifier: string;
        };
        /** @description Trusted business-backend response only. Must never be proxied to a renderer, written to logs or returned by local connection routes. */
        BindingExchange: {
            readerToken: string;
            reader: components["schemas"]["CentralReader"];
            /** Format: date-time */
            expiresAt: string;
        };
        ConnectionBegin: {
            /** Format: uuid */
            requestId: string;
            /** Format: uri */
            approvalUrl: string;
            displayCode: string;
            /** Format: date-time */
            expiresAt: string;
        };
        ConnectionComplete: {
            /** Format: uuid */
            requestId: string;
        };
        Empty: Record<string, never>;
        GrantCheck: {
            /** @constant */
            valid: true;
            /** Format: uuid */
            grantId: string;
            /** Format: uuid */
            releaseId: string;
        };
        ReleaseTransition: {
            reason: string;
        };
        Error: {
            error: {
                /** @enum {unknown} */
                code: "authentication_required" | "reference_forbidden" | "reference_not_found" | "reference_invalid" | "reference_unavailable" | "reference_rate_limited" | "reference_vocabulary_mismatch" | "reference_client_upgrade_required" | "reference_conflict" | "reference_unconfirmed";
                message: string;
            };
        };
        ReleaseList: {
            items: components["schemas"]["ReleaseDraft"][];
            activeReleaseId: string | null;
            nextCursor: string | null;
        };
        ReleaseDetail: {
            release: components["schemas"]["ReleaseDraft"];
            manifest: components["schemas"]["PublicationManifest"];
            activeReleaseId: string | null;
            sources: {
                sourceHash: string;
                totalChunks: number | null;
                receivedChunks: number;
                complete: boolean;
            }[];
        };
        PublicationCommandStatus: {
            /** @enum {string} */
            operation: "stage" | "source" | "publish" | "revoke";
            /** @constant */
            outcome: "not_observed";
        } | {
            /** @enum {string} */
            operation: "stage" | "source" | "publish" | "revoke";
            /** @constant */
            outcome: "committed";
            requestHash: string;
            release: components["schemas"]["ReleaseDraft"];
        };
        /** @enum {unknown} */
        Role: "cfo" | "finance" | "profit" | "cost" | "cashflow" | "tax";
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
        Warnings: string[];
        Roles: components["schemas"]["Role"][];
        Coverage: {
            totalPages: number | null;
            extractedPages: number | null;
            missingPages: number[];
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
    };
    responses: {
        /** @description Fixed bounded code and safe message; no book/query content, arbitrary upstream error or credentials. */
        error: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["Error"];
            };
        };
    };
    parameters: {
        id: string;
        referenceId: string;
        sourceHash: string;
        pageIndex: number;
        workspace: string;
        key: string;
        revision: string;
    };
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
    querySystemReferences: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ReferenceQuery"];
            };
        };
        responses: {
            /** @description At most six exact released snippets / 12000 UTF-16 code units */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["QueryResult"];
                };
            };
            default: components["responses"]["error"];
        };
    };
    checkSystemReferenceGrant: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["Empty"];
            };
        };
        responses: {
            /** @description Fresh authority and immutable release check; no excerpt content */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["GrantCheck"];
                };
            };
            default: components["responses"]["error"];
        };
    };
    getGrantedSystemReference: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["id"];
                referenceId: components["parameters"]["referenceId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Only an exact previously released excerpt, after current authorization */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SystemReference"];
                };
            };
            default: components["responses"]["error"];
        };
    };
    createReferenceBindingRequest: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["BindingCreate"];
            };
        };
        responses: {
            /** @description Matching code; no credential */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["BindingPending"];
                };
            };
            default: components["responses"]["error"];
        };
    };
    approveReferenceBindingRequest: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["BindingApprove"];
            };
        };
        responses: {
            /** @description Approved exactly once for the current eligible central customer */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            default: components["responses"]["error"];
        };
    };
    exchangeReferenceBindingProof: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["BindingProof"];
            };
        };
        responses: {
            /** @description Opaque purpose-limited reader credential, at most 7 days; no refresh */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["BindingExchange"];
                };
            };
            default: components["responses"]["error"];
        };
    };
    cancelReferenceBindingProof: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["BindingProof"];
            };
        };
        responses: {
            /** @description Cancelled or revoked without returning credentials */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            default: components["responses"]["error"];
        };
    };
    getReferenceConnection: {
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
            /** @description Current actor/workspace/generation safe state. embedded_ready uses application-bundled references by default without central login or client binding operations. session_ready reuses the current central session and has no client binding to begin, complete or unbind; ready denotes a client binding. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ConnectionStatus"];
                };
            };
            default: components["responses"]["error"];
        };
    };
    unbindReferenceConnection: {
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
            /** @description Local binding removed and generation fenced; remote uncertainty remains explicit */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ConnectionStatus"];
                };
            };
            default: components["responses"]["error"];
        };
    };
    getConnectedSystemReference: {
        parameters: {
            query?: never;
            header: {
                "X-Workspace-Id": components["parameters"]["workspace"];
            };
            path: {
                id: components["parameters"]["id"];
                referenceId: components["parameters"]["referenceId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Exact current-authorized system reference */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SystemReference"];
                };
            };
            default: components["responses"]["error"];
        };
    };
    beginReferenceConnection: {
        parameters: {
            query?: never;
            header: {
                "X-Workspace-Id": components["parameters"]["workspace"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["Empty"];
            };
        };
        responses: {
            /** @description Safe configured-origin approval URL and matching code only */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ConnectionBegin"];
                };
            };
            default: components["responses"]["error"];
        };
    };
    completeReferenceConnection: {
        parameters: {
            query?: never;
            header: {
                "X-Workspace-Id": components["parameters"]["workspace"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ConnectionComplete"];
            };
        };
        responses: {
            /** @description One explicit exchange attempt; no token/verifier */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ConnectionStatus"];
                };
            };
            default: components["responses"]["error"];
        };
    };
    listReferenceReleases: {
        parameters: {
            query: {
                corpusId: string;
                limit?: number;
                cursor?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Bounded owner metadata */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ReleaseList"];
                };
            };
            default: components["responses"]["error"];
        };
    };
    stageSystemReferenceRelease: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["key"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PublicationManifest"];
            };
        };
        responses: {
            /** @description Immutable staging manifest; not searchable */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ReleaseDraft"];
                };
            };
            default: components["responses"]["error"];
        };
    };
    stageSystemReferenceSourcePage: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["key"];
                "If-Match": components["parameters"]["revision"];
            };
            path: {
                id: components["parameters"]["id"];
                sourceHash: components["parameters"]["sourceHash"];
                pageIndex: components["parameters"]["pageIndex"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SourcePage"];
            };
        };
        responses: {
            /** @description Candidate state after hash-bound page admission */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ReleaseDraft"];
                };
            };
            default: components["responses"]["error"];
        };
    };
    publishSystemReferenceRelease: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["key"];
                "If-Match": components["parameters"]["revision"];
            };
            path: {
                id: components["parameters"]["id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ReleaseTransition"];
            };
        };
        responses: {
            /** @description Current authorized release state */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ReleaseDraft"];
                };
            };
            default: components["responses"]["error"];
        };
    };
    revokeSystemReferenceRelease: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["key"];
                "If-Match": components["parameters"]["revision"];
            };
            path: {
                id: components["parameters"]["id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ReleaseTransition"];
            };
        };
        responses: {
            /** @description Current authorized release state */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ReleaseDraft"];
                };
            };
            default: components["responses"]["error"];
        };
    };
    inspectReferenceRelease: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Bounded owner metadata */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ReleaseDetail"];
                };
            };
            default: components["responses"]["error"];
        };
    };
    inspectReferenceCommand: {
        parameters: {
            query: {
                corpusId: string;
                operation: "stage" | "source" | "publish" | "revoke";
            };
            header: {
                "Idempotency-Key": components["parameters"]["key"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Bounded owner metadata */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PublicationCommandStatus"];
                };
            };
            default: components["responses"]["error"];
        };
    };
}
