export interface paths {
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
    "/api/platform/v1/accounts": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["createPlatformAccount"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/platform/v1/accounts/{id}/password-reset": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["issuePlatformPasswordReset"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/auth/reset-password": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["consumePlatformPasswordReset"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/platform/v1/overview": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getPlatformOverview"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/platform/v1/enterprises": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["createEnterprise"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/platform/v1/enterprises/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch: operations["updateEnterprise"];
        trace?: never;
    };
    "/api/platform/v1/plans": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["createPlanVersion"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/platform/v1/accounts/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch: operations["updateAccountAccess"];
        trace?: never;
    };
    "/api/platform/v1/session": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["verifyPlatformMfa"];
        delete: operations["endPlatformSession"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: {
        SystemReferenceReleaseDraft: components["schemas"]["ReleaseDraft"];
        SystemReferencePublicationManifest: components["schemas"]["PublicationManifest"];
        SystemReferenceSourcePage: components["schemas"]["SourcePage"];
        CustomerAccess: {
            /** @enum {string} */
            status: "unmanaged" | "pending" | "suspended" | "unconfigured" | "scheduled" | "active" | "expired";
            workspaceId: string;
            workspaceName: string | null;
            /** @enum {string|null} */
            planCode: "trial" | "basic" | "pro" | null;
            /** Format: date-time */
            startsAt: string | null;
            /** Format: date-time */
            expiresAt: string | null;
            features: ("acquisition" | "agents" | "decision" | "crm" | "growth" | "outreach")[];
            canRead: boolean;
            canExecute: boolean;
            /** Format: date-time */
            checkedAt: string;
        };
        NewAccount: {
            workspaceId: string;
            name: string;
            account: string;
            password: string;
            /** @enum {string} */
            role: "manager" | "sales";
        };
        NewAccountCommand: {
            revision: number;
            reason: string;
            value: components["schemas"]["NewAccount"];
        };
        PasswordResetCommand: {
            revision: number;
            reason: string;
            value: Record<string, never>;
        };
        PasswordResetResult: {
            token: string;
            /** Format: date-time */
            expiresAt: string;
        };
        PasswordResetInput: {
            token: string;
            password: string;
        };
        Workspace: {
            id: string;
            name: string;
            contact: string;
            /** @enum {string} */
            status: "pending" | "active" | "suspended";
            planVersionId: string | null;
            startsAt: string | null;
            expiresAt: string | null;
            revision: number;
        };
        Plan: {
            id: string;
            version: number;
            /** @enum {string} */
            code: "trial" | "basic" | "pro";
            features: ("acquisition" | "agents" | "decision" | "crm" | "growth" | "outreach")[];
            seatLimit: number | null;
            durationDays: number | null;
            published: boolean;
        };
        Account: {
            id: string;
            name: string;
            email: string;
            workspaceId: string;
            /** @enum {string} */
            role: "sales" | "manager" | "admin" | "super_admin";
            /** @enum {string} */
            status: "active" | "disabled";
        };
        Audit: {
            id: string;
            actorId: string;
            action: string;
            targetId: string;
            reason: string;
            occurredAt: string;
            revision: number;
        };
        Overview: {
            revision: number;
            /** @enum {string} */
            role: "owner" | "operator";
            page: number;
            pageSize: number;
            workspaceCount: number;
            accountCount: number;
            auditCount: number;
            workspaces: components["schemas"]["Workspace"][];
            plans: components["schemas"]["Plan"][];
            accounts: components["schemas"]["Account"][];
            audits: components["schemas"]["Audit"][];
        };
        NewEnterprise: {
            name: string;
            contact: string;
            account: string;
            password: string;
        };
        WorkspaceUpdate: {
            /** @enum {string} */
            status: "pending" | "active" | "suspended";
            planVersionId: string | null;
            startsAt: string | null;
            expiresAt: string | null;
        };
        PlanDraft: {
            /** @enum {string} */
            code: "trial" | "basic" | "pro";
            features: ("acquisition" | "agents" | "decision" | "crm" | "growth" | "outreach")[];
            seatLimit: number | null;
            durationDays: number | null;
            published: boolean;
        };
        AccountAccess: {
            /** @enum {string} */
            action: "disable" | "enable" | "revoke";
        };
        NewEnterpriseCommand: {
            revision: number;
            reason: string;
            value: components["schemas"]["NewEnterprise"];
        };
        WorkspaceUpdateCommand: {
            revision: number;
            reason: string;
            value: components["schemas"]["WorkspaceUpdate"];
        };
        PlanDraftCommand: {
            revision: number;
            reason: string;
            value: components["schemas"]["PlanDraft"];
        };
        AccountAccessCommand: {
            revision: number;
            reason: string;
            value: components["schemas"]["AccountAccess"];
        };
        Error: {
            message: string;
        };
        Session: {
            authenticated: boolean;
        };
        AccountAccessResult: {
            id: string;
            /** @enum {string} */
            status: "active" | "disabled";
        };
        MfaInput: {
            code: string;
        };
        "$defs-Error": {
            error: {
                /** @enum {unknown} */
                code: "authentication_required" | "reference_forbidden" | "reference_not_found" | "reference_invalid" | "reference_unavailable" | "reference_rate_limited" | "reference_vocabulary_mismatch" | "reference_client_upgrade_required" | "reference_conflict" | "reference_unconfirmed";
                message: string;
            };
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
        ReleaseList: {
            items: components["schemas"]["ReleaseDraft"][];
            activeReleaseId: string | null;
            nextCursor: string | null;
        };
        /** @enum {unknown} */
        Role: "cfo" | "finance" | "profit" | "cost" | "cashflow" | "tax";
        Roles: components["schemas"]["Role"][];
        Coverage: {
            totalPages: number | null;
            extractedPages: number | null;
            missingPages: number[];
        };
        Warnings: string[];
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
        ReleaseTransition: {
            reason: string;
        };
    };
    responses: {
        /** @description Fixed bounded code and safe message; no book/query content, arbitrary upstream error or credentials. */
        error: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["$defs-Error"];
            };
        };
    };
    parameters: {
        key: string;
        id: string;
        sourceHash: string;
        pageIndex: number;
        revision: string;
    };
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
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
    createPlatformAccount: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["NewAccountCommand"];
            };
        };
        responses: {
            /** @description Created */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Account"];
                };
            };
        };
    };
    issuePlatformPasswordReset: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PasswordResetCommand"];
            };
        };
        responses: {
            /** @description One-time bearer token; expires in 15 minutes; never persisted in plaintext */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PasswordResetResult"];
                };
            };
        };
    };
    consumePlatformPasswordReset: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PasswordResetInput"];
            };
        };
        responses: {
            /** @description Password changed and sessions revoked */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        completed: boolean;
                    };
                };
            };
            /** @description Invalid, expired or already used token */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Rate limited */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    getPlatformOverview: {
        parameters: {
            query?: {
                page?: number;
                q?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Authenticated platform snapshot; paginated lists */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Overview"];
                };
            };
        };
    };
    createEnterprise: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["NewEnterpriseCommand"];
            };
        };
        responses: {
            /** @description Success */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Workspace"];
                };
            };
            /** @description Invalid input */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Session or MFA required */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Not authorized */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Revision or state conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    updateEnterprise: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["WorkspaceUpdateCommand"];
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Workspace"];
                };
            };
            /** @description Invalid input */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Session or MFA required */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Not authorized */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Revision or state conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    createPlanVersion: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PlanDraftCommand"];
            };
        };
        responses: {
            /** @description Success */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Plan"];
                };
            };
            /** @description Invalid input */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Session or MFA required */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Not authorized */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Revision or state conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    updateAccountAccess: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AccountAccessCommand"];
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AccountAccessResult"];
                };
            };
            /** @description Invalid input */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Session or MFA required */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Not authorized */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Revision or state conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    verifyPlatformMfa: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["MfaInput"];
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Session"];
                };
            };
            /** @description Invalid input */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Session or MFA required */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Not authorized */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Revision or state conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    endPlatformSession: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Session"];
                };
            };
            /** @description Invalid input */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Session or MFA required */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Not authorized */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Revision or state conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
}
