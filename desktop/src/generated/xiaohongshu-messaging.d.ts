export interface paths {
    "/api/v1/acquisition/xiaohongshu/drafts": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["listXhsDrafts"];
        put?: never;
        post: operations["createXhsDraft"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/acquisition/xiaohongshu/drafts/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["draftId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch: operations["editXhsDraft"];
        trace?: never;
    };
    "/api/v1/acquisition/xiaohongshu/drafts/{id}/approve": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["draftId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["approveXhsDraft"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/acquisition/xiaohongshu/drafts/{id}/claim": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["draftId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["claimXhsDraft"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/acquisition/xiaohongshu/drafts/{id}/receipt": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["draftId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["reportXhsReceipt"];
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
        XhsId: string;
        XhsDeviceId: string;
        XhsCreate: {
            /** Format: uuid */
            id: string;
            accountId: components["schemas"]["XhsId"];
            deviceId: components["schemas"]["XhsDeviceId"];
            recipientId: components["schemas"]["XhsId"];
            body: string;
        };
        XhsRevision: {
            revision: number;
        };
        XhsEdit: {
            revision: number;
            recipientId: components["schemas"]["XhsId"];
            body: string;
        };
        XhsReceipt: {
            /** @constant */
            status: "unknown";
        } | {
            /** @constant */
            status: "confirmed";
            serverMessageId: components["schemas"]["XhsId"];
        } | {
            /** @constant */
            status: "rejected";
            platformCode: number;
        };
        XhsReceiptReport: {
            /** Format: uuid */
            clientMessageId: string;
            generation: components["schemas"]["XhsId"];
            receipt: components["schemas"]["XhsReceipt"];
        };
        XhsDraft: {
            /** Format: uuid */
            id: string;
            accountId: components["schemas"]["XhsId"];
            deviceId: components["schemas"]["XhsDeviceId"];
            recipientId: components["schemas"]["XhsId"];
            body: string;
            revision: number;
            /** @enum {unknown} */
            status: "draft" | "approved" | "executing" | "unknown" | "confirmed" | "rejected";
            /** @description UTC Unix milliseconds */
            updatedAt: number;
            /** @description Approval expires at UTC Unix milliseconds */
            expiresAt?: number;
            quotaDay?: string;
            generation?: components["schemas"]["XhsId"];
            /** Format: uuid */
            clientMessageId?: string;
            receipt?: components["schemas"]["XhsReceipt"];
        };
        XhsCommand: {
            /** Format: uuid */
            commandId: string;
            workspaceId: components["schemas"]["XhsId"];
            actorId: components["schemas"]["XhsId"];
            deviceId: components["schemas"]["XhsDeviceId"];
            accountId: components["schemas"]["XhsId"];
            recipientId: components["schemas"]["XhsId"];
            body: string;
            revision: number;
            /** Format: uuid */
            clientMessageId: string;
            generation: components["schemas"]["XhsId"];
            /** @description UTC Unix milliseconds; local Python adapter converts to seconds */
            expiresAt: number;
        };
        XhsDraftList: {
            items: components["schemas"]["XhsDraft"][];
        };
        XhsError: {
            code: string;
            message: string;
            details: null;
            /** Format: uuid */
            requestId: string;
            /** @constant */
            retryable: false;
        };
    };
    responses: {
        /** @description Rejected request. No device credentials or provider response content is returned. */
        error: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["XhsError"];
            };
        };
    };
    parameters: {
        draftId: string;
    };
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
    listXhsDrafts: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Owned drafts only */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["XhsDraftList"];
                };
            };
            default: components["responses"]["error"];
        };
    };
    createXhsDraft: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["XhsCreate"];
            };
        };
        responses: {
            /** @description Draft */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["XhsDraft"];
                };
            };
            default: components["responses"]["error"];
        };
    };
    editXhsDraft: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["draftId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["XhsEdit"];
            };
        };
        responses: {
            /** @description Updated draft; invalidates old approval */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["XhsDraft"];
                };
            };
            default: components["responses"]["error"];
        };
    };
    approveXhsDraft: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["draftId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["XhsRevision"];
            };
        };
        responses: {
            /** @description Exact version approved for five minutes */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["XhsDraft"];
                };
            };
            default: components["responses"]["error"];
        };
    };
    claimXhsDraft: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["draftId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["XhsRevision"];
            };
        };
        responses: {
            /** @description One-time command issued only to bound device; lost responses must not resend */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["XhsCommand"];
                };
            };
            default: components["responses"]["error"];
        };
    };
    reportXhsReceipt: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["draftId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["XhsReceiptReport"];
            };
        };
        responses: {
            /** @description Correlated receipt */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["XhsDraft"];
                };
            };
            default: components["responses"]["error"];
        };
    };
}
