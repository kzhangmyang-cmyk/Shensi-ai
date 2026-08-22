export interface paths {
    "/api/v1/ai/providers": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List model providers */
        get: {
            parameters: {
                query?: {
                    cursor?: components["parameters"]["cursor"];
                    limit?: components["parameters"]["limit"];
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Cursor-paginated result */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["PagedResult"];
                    };
                };
                /** @description Unified API error */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/ai/connections": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List model connections */
        get: {
            parameters: {
                query?: {
                    cursor?: components["parameters"]["cursor"];
                    limit?: components["parameters"]["limit"];
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Cursor-paginated result */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["PagedResult"];
                    };
                };
                /** @description Unified API error */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        put?: never;
        /** Create model connection */
        post: {
            parameters: {
                query?: never;
                header: {
                    "Idempotency-Key": components["parameters"]["idempotencyKey"];
                };
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Model connection */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["model-connection.v1.schema"];
                    };
                };
                /** @description Unified API error */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description Unified API error */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/ai/connections/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["id"];
            };
            cookie?: never;
        };
        /** Get model connection */
        get: {
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
                /** @description Model connection */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["model-connection.v1.schema"];
                    };
                };
                /** @description Unified API error */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        /** Delete model connection */
        delete: {
            parameters: {
                query?: never;
                header: {
                    "Idempotency-Key": components["parameters"]["idempotencyKey"];
                };
                path: {
                    id: components["parameters"]["id"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Successful response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": Record<string, never>;
                    };
                };
                /** @description Unified API error */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description Unified API error */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description Connection is retained by active tasks or audit policy */
                409: {
                    headers: {
                        "X-Error-Code": "connection_in_use";
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        options?: never;
        head?: never;
        /** Update model connection */
        patch: {
            parameters: {
                query?: never;
                header: {
                    "Idempotency-Key": components["parameters"]["idempotencyKey"];
                };
                path: {
                    id: components["parameters"]["id"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Model connection */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["model-connection.v1.schema"];
                    };
                };
                /** @description Unified API error */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description Unified API error */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        trace?: never;
    };
    "/api/v1/ai/connections/{id}/models": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["id"];
            };
            cookie?: never;
        };
        /** List supported models */
        get: {
            parameters: {
                query?: {
                    cursor?: components["parameters"]["cursor"];
                    limit?: components["parameters"]["limit"];
                };
                header?: never;
                path: {
                    id: components["parameters"]["id"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Cursor-paginated result */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["PagedResult"];
                    };
                };
                /** @description Unified API error */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/ai/connections/{id}/test": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Test model connection */
        post: {
            parameters: {
                query?: never;
                header: {
                    "Idempotency-Key": components["parameters"]["idempotencyKey"];
                };
                path: {
                    id: components["parameters"]["id"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Accepted asynchronous operation */
                202: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["async-operation.v1.schema"];
                    };
                };
                /** @description Unified API error */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description Unified API error */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/ai/connections/{id}/activate": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Activate model connection */
        post: {
            parameters: {
                query?: never;
                header: {
                    "Idempotency-Key": components["parameters"]["idempotencyKey"];
                };
                path: {
                    id: components["parameters"]["id"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Model connection */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["model-connection.v1.schema"];
                    };
                };
                /** @description Unified API error */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description Unified API error */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/ai/calls": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List model call records */
        get: {
            parameters: {
                query?: {
                    cursor?: components["parameters"]["cursor"];
                    limit?: components["parameters"]["limit"];
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Cursor-paginated result */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["PagedResult"];
                    };
                };
                /** @description Unified API error */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/ai/calls/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["id"];
            };
            cookie?: never;
        };
        /** Get model call record */
        get: {
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
                /** @description Model call record */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["model-call-record.v1.schema"];
                    };
                };
                /** @description Unified API error */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/acquisition/providers": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List discovery providers */
        get: operations["listAcquisitionProviders"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/acquisition/provider-connections": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List provider connections */
        get: operations["listAcquisitionProviderConnections"];
        put?: never;
        /** Create provider connection */
        post: operations["createAcquisitionProviderConnection"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/acquisition/provider-connections/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        /** Get provider connection */
        get: operations["getAcquisitionProviderConnection"];
        put?: never;
        post?: never;
        /** Delete provider connection */
        delete: operations["deleteAcquisitionProviderConnection"];
        options?: never;
        head?: never;
        /** Update provider connection */
        patch: operations["updateAcquisitionProviderConnection"];
        trace?: never;
    };
    "/api/v1/acquisition/provider-connections/{id}/test": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Test provider connection */
        post: operations["testAcquisitionProviderConnection"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/acquisition/content-fetch-operations": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List content fetch operations */
        get: operations["listAcquisitionContentFetchOperations"];
        put?: never;
        /** Create content fetch operation */
        post: operations["createAcquisitionContentFetchOperation"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/acquisition/content-fetch-operations/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        /** Get content fetch operation */
        get: operations["getAcquisitionContentFetchOperation"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/acquisition/import-operations": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List import operations */
        get: operations["listAcquisitionImportOperations"];
        put?: never;
        /** Create import operation */
        post: operations["createAcquisitionImportOperation"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/acquisition/import-operations/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        /** Get import operation */
        get: operations["getAcquisitionImportOperation"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/acquisition/evidence/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["acquisitionId"];
            };
            cookie?: never;
        };
        /** Get discovery evidence */
        get: operations["getAcquisitionEvidence"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/acquisition/plans": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Create acquisition plan */
        post: operations["createAcquisitionPlan"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/acquisition/plans/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        /** Get acquisition plan */
        get: operations["getAcquisitionPlan"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /** Update acquisition plan */
        patch: operations["updateAcquisitionPlan"];
        trace?: never;
    };
    "/api/v1/acquisition/plans/{id}/revisions": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Create acquisition plan revision */
        post: operations["createAcquisitionPlanRevision"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/acquisition/plans/{id}/approval": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Approve acquisition plan */
        post: operations["approveAcquisitionPlan"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/acquisition/plans/{id}/runs": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Create acquisition run */
        post: operations["createAcquisitionRun"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/acquisition/runs/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        /** Get acquisition run */
        get: operations["getAcquisitionRun"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/acquisition/runs/{id}/shards": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        /** List acquisition run shards */
        get: operations["listAcquisitionRunShards"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/acquisition/runs/{id}/presentation": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        /** Get acquisition run presentation */
        get: operations["getAcquisitionRunPresentation"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/acquisition/runs/{id}/pause": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Pause acquisition run */
        post: operations["pauseAcquisitionRun"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/acquisition/runs/{id}/resume": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Resume acquisition run */
        post: operations["resumeAcquisitionRun"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/acquisition/runs/{id}/cancel": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Cancel acquisition run */
        post: operations["cancelAcquisitionRun"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/acquisition/visual-reader-sessions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Create an explicitly authorized visual reader session
         * @description The server derives the Plan, PlanVersion, Douyin platform, authorized visible top-level sample coverage, authorization clock, expiry, and final hard-capped limits from the referenced Run.
         */
        post: operations["createAcquisitionVisualReaderSession"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/acquisition/visual-reader-sessions/{sessionId}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                sessionId: string;
            };
            cookie?: never;
        };
        /** Get an authorized visual reader session */
        get: operations["getAcquisitionVisualReaderSession"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/acquisition/visual-reader-sessions/{sessionId}/observations:batch": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                sessionId: string;
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Persist a bounded batch of visible comment observations
         * @description Standard schemas validate each identifier independently; the Task 3 service must require every sourceUrl video segment to equal its videoId and the route, response session, and normalized observation sessionId values to agree before persistence or response.
         */
        post: operations["appendAcquisitionVisualReaderObservationBatch"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/acquisition/visual-reader-sessions/{sessionId}:complete": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                sessionId: string;
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Complete an authorized visual reader session */
        post: operations["completeAcquisitionVisualReaderSession"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/acquisition/visual-reader-sessions/{sessionId}:abort": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                sessionId: string;
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Abort an authorized visual reader session */
        post: operations["abortAcquisitionVisualReaderSession"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/acquisition/visual-reader-artifacts/{artifactId}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                artifactId: string;
            };
            cookie?: never;
        };
        /** Read an authorized redacted comment-card crop */
        get: operations["getAcquisitionVisualReaderArtifact"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/acquisition/candidates": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List candidates */
        get: operations["listAcquisitionCandidates"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/acquisition/candidates/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["acquisitionId"];
            };
            cookie?: never;
        };
        /** Get candidate */
        get: operations["getAcquisitionCandidate"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/acquisition/candidates/{id}/evidence": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["acquisitionId"];
            };
            cookie?: never;
        };
        /** List candidate evidence */
        get: operations["listAcquisitionCandidateEvidence"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/acquisition/candidates/{id}/identity-confirmation": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["acquisitionId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Confirm candidate identity */
        post: operations["confirmAcquisitionCandidateIdentity"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/acquisition/candidates/{candidateId}/intelligence-operations": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                candidateId: string;
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Create candidate intelligence operation */
        post: operations["createAcquisitionCandidateIntelligenceOperation"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/acquisition/candidate-intelligence-operations/{operationId}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                operationId: string;
            };
            cookie?: never;
        };
        /** Get candidate intelligence operation */
        get: operations["getAcquisitionCandidateIntelligenceOperation"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/acquisition/candidates/{candidateId}/intelligence-operation": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                candidateId: string;
            };
            cookie?: never;
        };
        /** Get latest candidate intelligence operation */
        get: operations["getLatestAcquisitionCandidateIntelligenceOperation"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/acquisition/candidate-intelligence-operations/{operationId}/retry": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                operationId: string;
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Retry candidate intelligence operation */
        post: operations["retryAcquisitionCandidateIntelligenceOperation"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/acquisition/candidates/{candidateId}/douyin-identity-resolution-operation": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                candidateId: string;
            };
            cookie?: never;
        };
        /** Get latest Douyin identity resolution operation */
        get: operations["getLatestAcquisitionDouyinIdentityResolutionOperation"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/acquisition/candidates/{candidateId}/douyin-identity-resolution-operations": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                candidateId: string;
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Create or retry Douyin identity resolution operation */
        post: operations["createAcquisitionDouyinIdentityResolutionOperation"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/acquisition/candidates/{id}/qualification": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["acquisitionId"];
            };
            cookie?: never;
        };
        /** Get qualification decision */
        get: operations["getAcquisitionCandidateQualification"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/acquisition/candidates/{id}/financial-value": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["acquisitionId"];
            };
            cookie?: never;
        };
        /** Get financial value decision */
        get: operations["getAcquisitionCandidateFinancialValue"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/acquisition/candidates/{id}/battle-card": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["acquisitionId"];
            };
            cookie?: never;
        };
        /** Get battle card */
        get: operations["getAcquisitionCandidateBattleCard"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/acquisition/candidates/{id}/reviews": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["acquisitionId"];
            };
            cookie?: never;
        };
        /** List review events */
        get: operations["listAcquisitionCandidateReviews"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/acquisition/candidates/{id}/review": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["acquisitionId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Review candidate */
        post: operations["reviewAcquisitionCandidate"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/acquisition/candidates/{id}/convert": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["acquisitionId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Convert candidate */
        post: operations["convertAcquisitionCandidate"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/acquisition/outcomes": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List outcome feedback */
        get: operations["listAcquisitionOutcomes"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/acquisition/performance": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Read acquisition funnel, currency-separated contract values, and owner briefing facts */
        get: operations["getAcquisitionPerformance"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/acquisition/copilot/sessions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Create copilot session */
        post: operations["createAcquisitionCopilotSession"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/acquisition/copilot/sessions/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["acquisitionId"];
            };
            cookie?: never;
        };
        /** Get copilot session */
        get: operations["getAcquisitionCopilotSession"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/acquisition/copilot/sessions/{id}/messages": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["acquisitionId"];
            };
            cookie?: never;
        };
        /** List copilot messages */
        get: operations["listAcquisitionCopilotMessages"];
        put?: never;
        /** Send copilot message */
        post: operations["sendAcquisitionCopilotMessage"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/acquisition/copilot/tasks/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["acquisitionId"];
            };
            cookie?: never;
        };
        /** Get copilot task */
        get: operations["getAcquisitionCopilotTask"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/acquisition/audit-events": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List audit events */
        get: operations["listAcquisitionAuditEvents"];
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
        AsyncOperation: components["schemas"]["async-operation.v1.schema"];
        ApiError: {
            code: string;
            message: string;
            details: unknown;
            requestId: string;
            retryable: boolean;
        } | {
            error: {
                code: string;
                message: string;
                details?: unknown;
                requestId?: string;
            };
        };
        PagedResult: {
            items: Record<string, never>[];
            nextCursor: string | null;
        };
        ModelProvider: components["schemas"]["model-provider.v1.schema"];
        ModelConnection: components["schemas"]["model-connection.v1.schema"];
        ModelCallRecord: components["schemas"]["model-call-record.v1.schema"];
        DiscoveryProvider: components["schemas"]["discovery-provider.v1.schema"];
        ProviderConnection: components["schemas"]["provider-connection.v1.schema"];
        ContentFetchOperation: components["schemas"]["content-fetch-operation.v1.schema"];
        ContentFetchOperationList: {
            items: components["schemas"]["content-fetch-operation.v1.schema"][];
        };
        ImportOperation: components["schemas"]["import-operation.v1.schema"];
        ImportOperationList: {
            items: components["schemas"]["import-operation.v1.schema"][];
        };
        CandidateIntelligenceOperation: components["schemas"]["candidate-intelligence-operation.v1.schema"];
        DouyinIdentityResolutionOperation: components["schemas"]["douyin-identity-resolution-operation.v1.schema"];
        AcquisitionPlan: components["schemas"]["acquisition-plan.v1.schema"];
        AcquisitionRun: components["schemas"]["acquisition-run.v1.schema"];
        AcquisitionOperationShard: components["schemas"]["acquisition-operation-shard.v1.schema"];
        AcquisitionRunPresentation: components["schemas"]["acquisition-run-presentation.v1.schema"];
        OrganizationCandidate: components["schemas"]["organization-candidate.v1.schema"];
        IndividualDemandSignal: components["schemas"]["individual-demand-signal.v1.schema"];
        Candidate: components["schemas"]["organization-candidate.v1.schema"] | components["schemas"]["individual-demand-signal.v1.schema"];
        CandidatePagedResult: {
            items: components["schemas"]["Candidate"][];
            nextCursor: string | null;
        };
        DiscoveryEvidence: components["schemas"]["discovery-evidence.v1.schema"];
        QualificationDecision: components["schemas"]["qualification-decision.v1.schema"];
        BattleCardV1: components["schemas"]["battle-card.v1.schema"];
        BattleCardV2: components["schemas"]["battle-card.v2.schema"];
        BattleCard: components["schemas"]["battle-card.v1.schema"] | components["schemas"]["battle-card.v2.schema"];
        ReviewEvent: components["schemas"]["review-event.v1.schema"];
        OutcomeFeedback: components["schemas"]["outcome-feedback.v1.schema"];
        FinancialValueDecision: components["schemas"]["financial-value-decision.v1.schema"];
        PartyRef: components["schemas"]["party-ref.v1.schema"];
        CopilotSession: components["schemas"]["copilot-session.v1.schema"];
        CopilotMessage: components["schemas"]["copilot-message.v1.schema"];
        CopilotTask: components["schemas"]["copilot-task.v1.schema"];
        PlatformConnection: components["schemas"]["platform-connection.v1.schema"];
        PlatformCapabilitySnapshot: components["schemas"]["platform-capability-snapshot.v1.schema"];
        PlatformEvent: components["schemas"]["platform-event.v1.schema"];
        DouyinCommentEvent: components["schemas"]["douyin-comment-event.v1.schema"];
        ActionPolicy: components["schemas"]["action-policy.v1.schema"];
        ActionReceipt: components["schemas"]["action-receipt.v1.schema"];
        DouyinVisualCommentObservation: components["schemas"]["douyinVisualCommentObservation"];
        OpaqueRectRedactionProof: components["schemas"]["visualReaderOpaqueRectRedactionProof"];
        VisualObservationSubmission: components["schemas"]["visualReaderObservationSubmission"];
        VisualReaderLimits: components["schemas"]["visualReaderLimits"];
        VisualReaderUsage: components["schemas"]["visualReaderUsage"];
        VisualReaderOutcome: components["schemas"]["visualReaderOutcome"];
        VisualReaderSession: components["schemas"]["visualReaderSession"];
        VisualReaderCreateRequest: components["schemas"]["visualReaderCreateRequest"];
        VisualObservationBatchRequest: components["schemas"]["visualReaderObservationBatchRequest"];
        VisualObservationBatchResponse: components["schemas"]["visualReaderObservationBatchResponse"];
        VisualReaderCompleteRequest: components["schemas"]["visualReaderCompleteRequest"];
        VisualReaderAbortRequest: components["schemas"]["visualReaderAbortRequest"];
        DiscoveryEvidencePagedResult: {
            items: components["schemas"]["discovery-evidence.v1.schema"][];
            nextCursor: string | null;
        };
        ReviewEventPagedResult: {
            items: components["schemas"]["review-event.v1.schema"][];
            nextCursor: string | null;
        };
        OutcomeFeedbackPagedResult: {
            items: components["schemas"]["outcome-feedback.v1.schema"][];
            nextCursor: string | null;
        };
        AcquisitionPerformance: {
            counts: {
                discovered: number;
                highIntent: number;
                approved: number;
                converted: number;
                contacted: number;
                quoted: number;
                won: number;
                lost: number;
            };
            rates: {
                highIntentRate: number | null;
                approvalRate: number | null;
                crmConversionRate: number | null;
                contactRate: number | null;
                quoteRate: number | null;
                winRate: number | null;
            };
            valuesByCurrency: {
                currency: string;
                estimatedPipelineMinor: number;
                quotedMinor: number;
                wonContractMinor: number;
            }[];
            cost: {
                /** @enum {string} */
                status: "available" | "not_aggregatable";
                executionCostMinor: number | null;
                currency: string | null;
                /** @enum {string} */
                coverage: "recorded_api_execution_only";
            };
            roi: {
                /** @enum {string} */
                status: "not_computable";
                /** @enum {string} */
                reason: "channel_cost_or_verified_margin_unavailable";
            };
            dataQuality: {
                missingAttribution: number;
                missingFinancial: number;
                truncated: boolean;
                /** Format: date-time */
                lastReconciledAt: string | null;
            };
            briefingFacts: {
                headlines: components["schemas"]["AcquisitionPerformanceFact"][];
                risks: components["schemas"]["AcquisitionPerformanceFact"][];
                actions: components["schemas"]["AcquisitionPerformanceFact"][];
                metricIds: string[];
            };
        };
        AcquisitionPerformanceFact: {
            metricId: string;
            text: string;
            evidenceRefs: string[];
        };
        CopilotMessagePagedResult: {
            items: components["schemas"]["copilot-message.v1.schema"][];
            nextCursor: string | null;
        };
        IdentityResolution: {
            /** @constant */
            status: "resolved";
            /** @enum {unknown} */
            basis: "organization_domain" | "organization_credit_code" | "provider_public_actor";
            resolverVersion: string;
            evidenceIds: string[];
            /** Format: date-time */
            resolvedAt: string;
            resolvedBy: string;
        };
        IdentityConfirmationResult: {
            candidate: components["schemas"]["Candidate"];
            resolution: components["schemas"]["IdentityResolution"];
        };
        ResearchAttempt: {
            id: string;
            candidateId: string;
            requestReason: string;
            budgetVersion: string;
            /** @enum {unknown} */
            status: "pending" | "running" | "completed" | "no_new_evidence" | "access_restricted" | "failed";
            newEvidenceIds: string[];
            terminationReason: string | null;
            /** Format: date-time */
            createdAt: string;
            /** Format: date-time */
            startedAt: string | null;
            /** Format: date-time */
            completedAt: string | null;
        };
        CandidateReviewResult: {
            candidate: components["schemas"]["Candidate"];
            review: components["schemas"]["review-event.v1.schema"];
            research: components["schemas"]["ResearchAttempt"] | null;
        };
        LeadConversion: {
            id: string;
            candidateId: string;
            decisionVersion: string;
            partyRef: components["schemas"]["party-ref.v1.schema"];
            leadId: string;
            reviewerId: string;
            evidenceSnapshotHash: string;
            /** Format: date-time */
            createdAt: string;
        };
        AuditEvent: {
            id: string;
            candidateId: string | null;
            actorId: string;
            eventType: string;
            /** @enum {unknown} */
            fromStatus: "discovered" | "unresolvable" | "normalized" | "qualified" | "pending_review" | "approved" | "rejected" | "do_not_contact" | "needs_research" | "converted_to_lead" | null;
            /** @enum {unknown} */
            toStatus: "discovered" | "unresolvable" | "normalized" | "qualified" | "pending_review" | "approved" | "rejected" | "do_not_contact" | "needs_research" | "converted_to_lead" | null;
            resourceId: string;
            /** Format: date-time */
            createdAt: string;
        };
        AuditEventPagedResult: {
            items: components["schemas"]["AuditEvent"][];
            nextCursor: string | null;
        };
        /** ModelConnection */
        "model-connection.v1.schema": {
            id: string;
            ownerId: string;
            teamId?: string | null;
            /** @enum {unknown} */
            provider: "openai" | "moonshot" | "minimax" | "zhipu" | "deepseek" | "qwen" | "doubao" | "hunyuan" | "qianfan";
            model: string;
            baseUrlFingerprint?: string;
            credentialVersion: number;
            capabilitySnapshot: {
                structuredOutput: boolean;
                toolCalling: boolean;
                parallelToolCalling: boolean;
                streaming: boolean;
                modelListing: boolean;
            };
            /** @enum {unknown} */
            status: "active" | "inactive" | "disabled";
            /** Format: date-time */
            createdAt: string;
            /** Format: date-time */
            updatedAt?: string;
        };
        /** ApiError */
        "api-error.v1.schema": {
            code: string;
            message: string;
            details: unknown;
            requestId: string;
            retryable: boolean;
        } | {
            error: {
                code: string;
                message: string;
                details?: unknown;
                requestId?: string;
            };
        };
        /** AsyncOperation */
        "async-operation.v1.schema": {
            id: string;
            kind: string;
            /** @enum {unknown} */
            status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
            resourceId?: string | null;
            error?: null | components["schemas"]["api-error.v1.schema"];
            /** Format: date-time */
            createdAt: string;
            /** Format: date-time */
            completedAt?: string | null;
        };
        /** ModelCallRecord */
        "model-call-record.v1.schema": {
            id: string;
            ownerId: string;
            teamId: string;
            jobId: string;
            attemptId: string;
            connectionId: string;
            credentialVersion: number;
            capabilitySnapshotHash: string;
            provider: string;
            baseUrlFingerprint: string;
            model: string;
            promptVersion: string;
            schemaVersion: string;
            requestId: string;
            providerRequestId?: string | null;
            inputTokens: number;
            outputTokens: number;
            reasoningTokens: number;
            latencyMs: number;
            /** @enum {unknown} */
            status: "succeeded" | "failed";
            error: Record<string, never> | null;
            cost: {
                amountMinor: number;
                currency: string;
                /** @enum {unknown} */
                kind: "estimated" | "actual" | "unknown";
            };
            parameterHash: string;
            resultHash: string;
            /** Format: date-time */
            createdAt: string;
        };
        /** ProviderConnection */
        "provider-connection.v1.schema": {
            id: string;
            ownerId: string;
            teamId: string | null;
            providerId: string;
            /** @enum {unknown} */
            kind: "search" | "content_fetch" | "import";
            /** @enum {unknown} */
            status: "active" | "inactive" | "disabled" | "error";
            credentialVersion: number;
            /** Format: date-time */
            lastHealthAt: string | null;
            /** @enum {unknown} */
            lastHealthStatus: "untested" | "passed" | "failed";
            lastErrorCode: string | null;
            lastHealthMessage: string;
            usage: string;
            /** Format: date-time */
            createdAt: string;
        };
        /** ContentFetchOperation */
        "content-fetch-operation.v1.schema": ({
            id: string;
            ownerId: string;
            teamId: string;
            actorId: string;
            /** Format: uri */
            sourceUrl: string;
            /** Format: uri */
            finalUrl: string | null;
            /** @enum {unknown} */
            subjectChannel: "organization" | "individual";
            /** @enum {unknown} */
            status: "queued" | "running" | "succeeded" | "partial_success" | "failed" | "access_restricted";
            /** @enum {string|null} */
            accessStatus: "public_content" | "access_restricted" | null;
            httpStatus: number | null;
            contentType: string | null;
            title: string | null;
            rawArtifactHash: string | null;
            contentHash: string | null;
            evidenceCount: number;
            evidenceIds: string[];
            candidateCount: number;
            candidateIds: string[];
            commentSampleSummary: null | {
                /** @enum {unknown} */
                status: "skipped" | "succeeded" | "succeeded_empty" | "partial_success" | "failed";
                videoCount: number;
                pagesFetched: number;
                commentsSampled: number;
                eventCount: number;
                evidenceCount: number;
                candidateIds: string[];
                unresolvedActorCount: number;
                strongSignalCount: number;
                invalidCommentCount: number;
                errors: {
                    /** Format: uri */
                    sourceUrl: string;
                    videoId: string;
                    /** @enum {unknown} */
                    code: "public_sample_unavailable" | "access_restricted" | "rate_limited" | "video_id_unresolved" | "source_payload_invalid" | "no_public_comments";
                }[];
                usage: {
                    requests: number;
                    results: number;
                    amountMinor: number;
                    durationSeconds: number;
                };
            };
            errorCode: string | null;
            /** Format: date-time */
            createdAt: string;
            /** Format: date-time */
            startedAt: string | null;
            /** Format: date-time */
            completedAt: string | null;
        } & (unknown & unknown & ({
            /** @constant */
            candidateCount?: 0;
            candidateIds?: unknown[];
        } | {
            /** @constant */
            candidateCount?: 1;
            candidateIds?: unknown[];
        } | {
            /** @constant */
            candidateCount?: 2;
            candidateIds?: unknown[];
        } | {
            /** @constant */
            candidateCount?: 3;
            candidateIds?: unknown[];
        } | {
            /** @constant */
            candidateCount?: 4;
            candidateIds?: unknown[];
        } | {
            /** @constant */
            candidateCount?: 5;
            candidateIds?: unknown[];
        } | {
            /** @constant */
            candidateCount?: 6;
            candidateIds?: unknown[];
        } | {
            /** @constant */
            candidateCount?: 7;
            candidateIds?: unknown[];
        } | {
            /** @constant */
            candidateCount?: 8;
            candidateIds?: unknown[];
        } | {
            /** @constant */
            candidateCount?: 9;
            candidateIds?: unknown[];
        } | {
            /** @constant */
            candidateCount?: 10;
            candidateIds?: unknown[];
        } | {
            /** @constant */
            candidateCount?: 11;
            candidateIds?: unknown[];
        } | {
            /** @constant */
            candidateCount?: 12;
            candidateIds?: unknown[];
        } | {
            /** @constant */
            candidateCount?: 13;
            candidateIds?: unknown[];
        } | {
            /** @constant */
            candidateCount?: 14;
            candidateIds?: unknown[];
        } | {
            /** @constant */
            candidateCount?: 15;
            candidateIds?: unknown[];
        } | {
            /** @constant */
            candidateCount?: 16;
            candidateIds?: unknown[];
        } | {
            /** @constant */
            candidateCount?: 17;
            candidateIds?: unknown[];
        } | {
            /** @constant */
            candidateCount?: 18;
            candidateIds?: unknown[];
        } | {
            /** @constant */
            candidateCount?: 19;
            candidateIds?: unknown[];
        } | {
            /** @constant */
            candidateCount?: 20;
            candidateIds?: unknown[];
        } | {
            /** @constant */
            candidateCount?: 21;
            candidateIds?: unknown[];
        } | {
            /** @constant */
            candidateCount?: 22;
            candidateIds?: unknown[];
        } | {
            /** @constant */
            candidateCount?: 23;
            candidateIds?: unknown[];
        } | {
            /** @constant */
            candidateCount?: 24;
            candidateIds?: unknown[];
        } | {
            /** @constant */
            candidateCount?: 25;
            candidateIds?: unknown[];
        } | {
            /** @constant */
            candidateCount?: 26;
            candidateIds?: unknown[];
        } | {
            /** @constant */
            candidateCount?: 27;
            candidateIds?: unknown[];
        } | {
            /** @constant */
            candidateCount?: 28;
            candidateIds?: unknown[];
        } | {
            /** @constant */
            candidateCount?: 29;
            candidateIds?: unknown[];
        } | {
            /** @constant */
            candidateCount?: 30;
            candidateIds?: unknown[];
        } | {
            /** @constant */
            candidateCount?: 31;
            candidateIds?: unknown[];
        } | {
            /** @constant */
            candidateCount?: 32;
            candidateIds?: unknown[];
        } | {
            /** @constant */
            candidateCount?: 33;
            candidateIds?: unknown[];
        } | {
            /** @constant */
            candidateCount?: 34;
            candidateIds?: unknown[];
        } | {
            /** @constant */
            candidateCount?: 35;
            candidateIds?: unknown[];
        } | {
            /** @constant */
            candidateCount?: 36;
            candidateIds?: unknown[];
        } | {
            /** @constant */
            candidateCount?: 37;
            candidateIds?: unknown[];
        } | {
            /** @constant */
            candidateCount?: 38;
            candidateIds?: unknown[];
        } | {
            /** @constant */
            candidateCount?: 39;
            candidateIds?: unknown[];
        } | {
            /** @constant */
            candidateCount?: 40;
            candidateIds?: unknown[];
        } | {
            /** @constant */
            candidateCount?: 41;
            candidateIds?: unknown[];
        } | {
            /** @constant */
            candidateCount?: 42;
            candidateIds?: unknown[];
        } | {
            /** @constant */
            candidateCount?: 43;
            candidateIds?: unknown[];
        } | {
            /** @constant */
            candidateCount?: 44;
            candidateIds?: unknown[];
        } | {
            /** @constant */
            candidateCount?: 45;
            candidateIds?: unknown[];
        } | {
            /** @constant */
            candidateCount?: 46;
            candidateIds?: unknown[];
        } | {
            /** @constant */
            candidateCount?: 47;
            candidateIds?: unknown[];
        } | {
            /** @constant */
            candidateCount?: 48;
            candidateIds?: unknown[];
        } | {
            /** @constant */
            candidateCount?: 49;
            candidateIds?: unknown[];
        } | {
            /** @constant */
            candidateCount?: 50;
            candidateIds?: unknown[];
        } | {
            /** @constant */
            candidateCount?: 51;
            candidateIds?: unknown[];
        } | {
            /** @constant */
            candidateCount?: 52;
            candidateIds?: unknown[];
        } | {
            /** @constant */
            candidateCount?: 53;
            candidateIds?: unknown[];
        } | {
            /** @constant */
            candidateCount?: 54;
            candidateIds?: unknown[];
        } | {
            /** @constant */
            candidateCount?: 55;
            candidateIds?: unknown[];
        } | {
            /** @constant */
            candidateCount?: 56;
            candidateIds?: unknown[];
        } | {
            /** @constant */
            candidateCount?: 57;
            candidateIds?: unknown[];
        } | {
            /** @constant */
            candidateCount?: 58;
            candidateIds?: unknown[];
        } | {
            /** @constant */
            candidateCount?: 59;
            candidateIds?: unknown[];
        } | {
            /** @constant */
            candidateCount?: 60;
            candidateIds?: unknown[];
        } | {
            /** @constant */
            candidateCount?: 61;
            candidateIds?: unknown[];
        } | {
            /** @constant */
            candidateCount?: 62;
            candidateIds?: unknown[];
        } | {
            /** @constant */
            candidateCount?: 63;
            candidateIds?: unknown[];
        } | {
            /** @constant */
            candidateCount?: 64;
            candidateIds?: unknown[];
        } | {
            /** @constant */
            candidateCount?: 65;
            candidateIds?: unknown[];
        } | {
            /** @constant */
            candidateCount?: 66;
            candidateIds?: unknown[];
        } | {
            /** @constant */
            candidateCount?: 67;
            candidateIds?: unknown[];
        } | {
            /** @constant */
            candidateCount?: 68;
            candidateIds?: unknown[];
        } | {
            /** @constant */
            candidateCount?: 69;
            candidateIds?: unknown[];
        } | {
            /** @constant */
            candidateCount?: 70;
            candidateIds?: unknown[];
        } | {
            /** @constant */
            candidateCount?: 71;
            candidateIds?: unknown[];
        } | {
            /** @constant */
            candidateCount?: 72;
            candidateIds?: unknown[];
        } | {
            /** @constant */
            candidateCount?: 73;
            candidateIds?: unknown[];
        } | {
            /** @constant */
            candidateCount?: 74;
            candidateIds?: unknown[];
        } | {
            /** @constant */
            candidateCount?: 75;
            candidateIds?: unknown[];
        } | {
            /** @constant */
            candidateCount?: 76;
            candidateIds?: unknown[];
        } | {
            /** @constant */
            candidateCount?: 77;
            candidateIds?: unknown[];
        } | {
            /** @constant */
            candidateCount?: 78;
            candidateIds?: unknown[];
        } | {
            /** @constant */
            candidateCount?: 79;
            candidateIds?: unknown[];
        } | {
            /** @constant */
            candidateCount?: 80;
            candidateIds?: unknown[];
        } | {
            /** @constant */
            candidateCount?: 81;
            candidateIds?: unknown[];
        } | {
            /** @constant */
            candidateCount?: 82;
            candidateIds?: unknown[];
        } | {
            /** @constant */
            candidateCount?: 83;
            candidateIds?: unknown[];
        } | {
            /** @constant */
            candidateCount?: 84;
            candidateIds?: unknown[];
        } | {
            /** @constant */
            candidateCount?: 85;
            candidateIds?: unknown[];
        } | {
            /** @constant */
            candidateCount?: 86;
            candidateIds?: unknown[];
        } | {
            /** @constant */
            candidateCount?: 87;
            candidateIds?: unknown[];
        } | {
            /** @constant */
            candidateCount?: 88;
            candidateIds?: unknown[];
        } | {
            /** @constant */
            candidateCount?: 89;
            candidateIds?: unknown[];
        } | {
            /** @constant */
            candidateCount?: 90;
            candidateIds?: unknown[];
        } | {
            /** @constant */
            candidateCount?: 91;
            candidateIds?: unknown[];
        } | {
            /** @constant */
            candidateCount?: 92;
            candidateIds?: unknown[];
        } | {
            /** @constant */
            candidateCount?: 93;
            candidateIds?: unknown[];
        } | {
            /** @constant */
            candidateCount?: 94;
            candidateIds?: unknown[];
        } | {
            /** @constant */
            candidateCount?: 95;
            candidateIds?: unknown[];
        } | {
            /** @constant */
            candidateCount?: 96;
            candidateIds?: unknown[];
        } | {
            /** @constant */
            candidateCount?: 97;
            candidateIds?: unknown[];
        } | {
            /** @constant */
            candidateCount?: 98;
            candidateIds?: unknown[];
        } | {
            /** @constant */
            candidateCount?: 99;
            candidateIds?: unknown[];
        } | {
            /** @constant */
            candidateCount?: 100;
            candidateIds?: unknown[];
        } | {
            /** @constant */
            candidateCount?: 101;
            candidateIds?: unknown[];
        }))) & ({
            /** @enum {unknown} */
            status?: "succeeded" | "partial_success" | "access_restricted";
            /** @constant */
            evidenceCount?: 1;
            evidenceIds?: unknown[];
        } | {
            /** @enum {unknown} */
            status?: "queued" | "running";
            /** @constant */
            evidenceCount?: 0;
            evidenceIds?: unknown[];
        } | {
            /** @constant */
            status?: "failed";
            /** @constant */
            evidenceCount?: 0;
            evidenceIds?: unknown[];
        } | {
            /** @constant */
            status?: "failed";
            /** @constant */
            evidenceCount?: 1;
            evidenceIds?: unknown[];
        });
        /** ImportOperation */
        "import-operation.v1.schema": {
            id: string;
            ownerId: string;
            teamId: string;
            actorId: string;
            fileName: string;
            /** @enum {unknown} */
            mediaType: "text/csv" | "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
            /** @enum {unknown} */
            subjectChannel: "organization" | "individual";
            artifactHash: string;
            /** @enum {unknown} */
            status: "queued" | "running" | "succeeded" | "partial_success" | "failed";
            rowCount: number;
            acceptedRowCount: number;
            errorRows: {
                sheetName: string;
                rowNumber: number;
                code: string;
                message: string;
            }[];
            evidenceCount: number;
            evidenceIds: string[];
            candidateCount: number;
            candidateIds: string[];
            errorCode: string | null;
            /** Format: date-time */
            createdAt: string;
            /** Format: date-time */
            startedAt: string | null;
            /** Format: date-time */
            completedAt: string | null;
        } & (unknown & unknown & (unknown | {
            /** @constant */
            evidenceCount: 0;
            evidenceIds: unknown[];
        } | {
            evidenceCount: number;
            evidenceIds: unknown[];
        }) & (unknown | {
            /** @constant */
            candidateCount: 0;
            candidateIds: unknown[];
        } | {
            candidateCount: number;
            candidateIds: unknown[];
        }));
        /** DiscoveryEvidence */
        "discovery-evidence.v1.schema": {
            id: string;
            /** @enum {unknown} */
            targetType: "organization" | "individual_signal";
            sourcePlatform: string;
            sourceTitle: string;
            sourceSnippet: string;
            /** Format: date-time */
            publishedAt: string | null;
            /** Format: date-time */
            fetchedAt: string;
            locale: string;
            rawArtifactHash: string;
            contentHash: string;
            provenance: {
                /** @constant */
                kind: "search_result";
                provider: string;
                providerConnectionId?: string;
                requestId?: string;
                providerRecordId?: string;
                queryText: string;
                /** Format: uri */
                sourceUrl: string;
                resultRank: number | null;
                sourceType?: string;
            } | {
                /** @constant */
                kind: "user_submitted_url";
                /** Format: uri */
                sourceUrl: string;
                submittedBy: string;
            } | {
                /** @constant */
                kind: "controlled_public_page";
                /** Format: uri */
                sourceUrl: string;
                discoveredFromEvidenceId: string;
                redirectChain: string[];
                /** @constant */
                extractorVersion: "douyin-public-profile-v1";
            } | {
                /** @constant */
                kind: "platform_public_event";
                /** Format: uri */
                sourceUrl: string;
                platformEventId: string;
                providerVersion: string;
                /** @constant */
                coverage: "public_top_level_sample";
            } | {
                /** @constant */
                kind: "authorized_visual_observation";
                /** Format: uri */
                sourceUrl: string;
                observationId: string;
                sessionId: string;
                /** @enum {unknown} */
                extractionMethod: "dom" | "accessibility" | "ocr";
                visibleTextConfidence: number;
                /** @constant */
                coverage: "authorized_visible_top_level_sample";
                artifactId: string | null;
                domTextHash: string | null;
                ocrTextHash: string | null;
            } | {
                /** @constant */
                kind: "import_artifact_row";
                importBatchId: string;
                artifactHash: string;
                sheetName: string;
                rowNumber: number;
                /** Format: uri */
                sourceUrl?: string;
            };
            /** @enum {unknown} */
            accessStatus: "indexed_summary" | "public_content" | "user_supplied" | "access_restricted";
        } & (unknown & unknown);
        budgetUsage: {
            requests: number;
            results: number;
            amountMinor: number;
            durationSeconds: number;
        };
        douyinPublicCommentSamplePolicy: {
            enabled: boolean;
            maxVideosPerRun: number;
            maxCommentsPerVideo: number;
            maxPagesPerVideo: number;
        };
        providerConnection: {
            connectionId: string;
            providerId: string;
            /** @enum {unknown} */
            kind: "search" | "content_fetch" | "import";
            /** @enum {unknown} */
            status: "active" | "inactive" | "disabled";
            credentialVersion: number;
        };
        operation: {
            operationId: string;
            /** @enum {unknown} */
            subjectChannel: "organization" | "individual";
            /** @enum {unknown} */
            kind: "search" | "content_fetch" | "import_rows";
            connectionId: string;
            query?: string;
            sourceRef?: string;
            allocatedBudget: components["schemas"]["budgetUsage"];
        };
        budgetSnapshot: {
            billingCurrency: string;
            maxRequests: number;
            maxResults: number;
            maxAmountMinor: number;
            maxDurationSeconds: number;
        };
        modelSnapshot: {
            jobSnapshotId: string;
            connectionId: string;
            credentialVersion: number;
            provider: string;
            model: string;
            capabilitySnapshotHash: string;
            promptVersion: string;
            schemaVersion: string;
            promptHash: string;
            schemaHash: string;
        };
        payload: {
            /** @enum {unknown} */
            targetPlatform?: "douyin" | "web";
            douyinPublicCommentSample?: components["schemas"]["douyinPublicCommentSamplePolicy"];
            name: string;
            objective: string;
            icp: {
                industries: string[];
                regions: string[];
                organizationCriteria: string[];
                individualCriteria: string[];
                exclusionRules: string[];
            };
            subjectChannels: {
                organization: boolean;
                individual: boolean;
            };
            providerConnections: components["schemas"]["providerConnection"][];
            operations: components["schemas"]["operation"][];
            budgetSnapshot: components["schemas"]["budgetSnapshot"];
            modelSnapshotRef: components["schemas"]["modelSnapshot"];
            stopConditions: {
                stopWhenBudgetExhausted: boolean;
                stopWhenNoMoreResults: boolean;
            };
        } & unknown;
        /** AcquisitionPlan */
        "acquisition-plan.v1.schema": {
            id: string;
            ownerId: string;
            teamId: string;
            /** @enum {unknown} */
            status: "draft" | "approved" | "archived";
            version: number;
            revision: number;
            etag: string;
            currentVersionId: string;
            approvedVersionId: string | null;
            approvedSnapshotHash: string | null;
            approvedBy: string | null;
            /** Format: date-time */
            approvedAt: string | null;
            budgetSnapshot: components["schemas"]["budgetSnapshot"];
            payload: components["schemas"]["payload"];
            createdBy: string;
            /** Format: date-time */
            createdAt: string;
            updatedBy: string;
            /** Format: date-time */
            updatedAt: string;
            $defs: {
                budgetUsage: {
                    requests: number;
                    results: number;
                    amountMinor: number;
                    durationSeconds: number;
                };
                budgetSnapshot: {
                    billingCurrency: string;
                    maxRequests: number;
                    maxResults: number;
                    maxAmountMinor: number;
                    maxDurationSeconds: number;
                };
                modelSnapshot: {
                    jobSnapshotId: string;
                    connectionId: string;
                    credentialVersion: number;
                    provider: string;
                    model: string;
                    capabilitySnapshotHash: string;
                    promptVersion: string;
                    schemaVersion: string;
                    promptHash: string;
                    schemaHash: string;
                };
                providerConnection: {
                    connectionId: string;
                    providerId: string;
                    /** @enum {unknown} */
                    kind: "search" | "content_fetch" | "import";
                    /** @enum {unknown} */
                    status: "active" | "inactive" | "disabled";
                    credentialVersion: number;
                };
                operation: {
                    operationId: string;
                    /** @enum {unknown} */
                    subjectChannel: "organization" | "individual";
                    /** @enum {unknown} */
                    kind: "search" | "content_fetch" | "import_rows";
                    connectionId: string;
                    query?: string;
                    sourceRef?: string;
                    allocatedBudget: components["schemas"]["budgetUsage"];
                };
                douyinPublicCommentSamplePolicy: {
                    enabled: boolean;
                    maxVideosPerRun: number;
                    maxCommentsPerVideo: number;
                    maxPagesPerVideo: number;
                };
                payload: {
                    /** @enum {unknown} */
                    targetPlatform?: "douyin" | "web";
                    douyinPublicCommentSample?: components["schemas"]["douyinPublicCommentSamplePolicy"];
                    name: string;
                    objective: string;
                    icp: {
                        industries: string[];
                        regions: string[];
                        organizationCriteria: string[];
                        individualCriteria: string[];
                        exclusionRules: string[];
                    };
                    subjectChannels: {
                        organization: boolean;
                        individual: boolean;
                    };
                    providerConnections: components["schemas"]["providerConnection"][];
                    operations: components["schemas"]["operation"][];
                    budgetSnapshot: components["schemas"]["budgetSnapshot"];
                    modelSnapshotRef: components["schemas"]["modelSnapshot"];
                    stopConditions: {
                        stopWhenBudgetExhausted: boolean;
                        stopWhenNoMoreResults: boolean;
                    };
                } & unknown;
            };
        };
        /** AcquisitionRun */
        "acquisition-run.v1.schema": {
            id: string;
            ownerId: string;
            teamId: string;
            planId: string;
            planVersionId: string;
            planVersion: number;
            planSnapshotHash: string;
            parentRunId: string | null;
            /** @enum {unknown} */
            status: "queued" | "running" | "pause_requested" | "paused" | "cancel_requested" | "cancelled" | "succeeded" | "succeeded_empty" | "partial_success" | "failed" | "budget_exhausted";
            /** @enum {unknown} */
            terminationIntent: "cancelled" | "budget_exhausted" | null;
            revision: number;
            etag: string;
            budgetSnapshotId: string;
            budgetSnapshot: components["schemas"]["budgetSnapshot"];
            budgetSnapshotHash: string;
            billingCurrency: string;
            modelSnapshotRef: components["schemas"]["modelSnapshot"];
            consumedBudget: components["schemas"]["budgetUsage"];
            evidenceCount: number;
            reason: string | null;
            createdBy: string;
            /** Format: date-time */
            createdAt: string;
            updatedBy: string;
            /** Format: date-time */
            updatedAt: string;
            /** Format: date-time */
            completedAt: string | null;
            $defs: {
                budgetUsage: {
                    requests: number;
                    results: number;
                    amountMinor: number;
                    durationSeconds: number;
                };
                budgetSnapshot: {
                    billingCurrency: string;
                    maxRequests: number;
                    maxResults: number;
                    maxAmountMinor: number;
                    maxDurationSeconds: number;
                };
                modelSnapshot: {
                    jobSnapshotId: string;
                    connectionId: string;
                    credentialVersion: number;
                    provider: string;
                    model: string;
                    capabilitySnapshotHash: string;
                    promptVersion: string;
                    schemaVersion: string;
                    promptHash: string;
                    schemaHash: string;
                };
            };
        };
        /** AcquisitionRunPresentation */
        "acquisition-run-presentation.v1.schema": {
            run: {
                id: string;
                /** @enum {string} */
                status: "queued" | "running" | "pause_requested" | "paused" | "cancel_requested" | "cancelled" | "succeeded" | "succeeded_empty" | "partial_success" | "failed" | "budget_exhausted";
                etag: string;
                /** Format: date-time */
                updatedAt: string;
                /** Format: date-time */
                completedAt: null | string;
            };
            providers: {
                shardId: string;
                connectionId: string;
                providerId: string;
                status: string;
                rawResultCount: number;
                acceptedResultCount: number;
                duplicateResultCount: number;
                failedResultCount: number;
                errorCode: null | string;
                /** Format: date-time */
                retryAfterAt: null | string;
            }[];
            summary: {
                sourcesSearched: number;
                /** @description 所有运行分片持久化的执行结果页数。 */
                pagesAnalyzed: number;
                organizationsFound: number;
                dedupedCandidates: number;
                validOpportunities: number;
                highIntent: number;
                financialEvaluatedHighIntentCount: number;
                financialPendingHighIntentCount: number;
                discoveredVideos: number;
                commentsSampled: number;
                validDemandSignals: number;
                unresolvedActors: number;
                highPotentialSignals: number;
                /** @description 仅合计高意向且绑定当前资格决定的财务值；币种不换算。 */
                expectedRevenueByCurrency: {
                    currency: string;
                    amountMinor: number;
                }[];
            };
            automationSteps: {
                /** @enum {string} */
                id: "discover_video_urls" | "resolve_video_ids" | "fetch_public_comment_samples" | "normalize_platform_events" | "aggregate_actor_signals" | "qualify_candidates" | "refresh_run_presentation";
                /** @enum {string} */
                status: "pending" | "running" | "succeeded" | "partial_success" | "failed" | "skipped";
                /** Format: date-time */
                startedAt: null | string;
                /** Format: date-time */
                completedAt: null | string;
                durationMs: null | number;
                processedCount: number;
                /** @enum {null|string} */
                errorCode: null | "public_sample_unavailable" | "access_restricted" | "rate_limited" | "video_id_unresolved" | "source_payload_invalid" | "no_public_comments" | "model_output_invalid";
                message: string;
            }[];
            authorizedVisualReader?: {
                sessionId: string;
                /** @constant */
                coverage: "authorized_visible_top_level_sample";
                /** @enum {string} */
                status: "created" | "collecting" | "completed" | "partial_success" | "aborted" | "expired";
                limits: {
                    maxVideos: number;
                    maxCommentsPerVideo: number;
                    maxScrolls: number;
                    maxOcrCalls: number;
                    maxDurationMs: number;
                };
                usage: {
                    videoCount: number;
                    observationCount: number;
                    scrollCount: number;
                    ocrCallCount: number;
                    domObservationCount: number;
                    accessibilityObservationCount: number;
                    ocrObservationCount: number;
                    lowConfidenceObservationCount: number;
                    artifactCount: number;
                };
                outcome: {
                    /** @enum {string} */
                    status: "completed" | "partial_success" | "aborted" | "expired";
                    videoCount: number;
                    observationCount: number;
                    domObservationCount: number;
                    accessibilityObservationCount: number;
                    ocrObservationCount: number;
                    lowConfidenceObservationCount: number;
                    artifactCount: number;
                    errorCodes: ("visual_reader_not_enabled" | "visual_reader_session_expired" | "visual_reader_budget_exhausted" | "visual_source_invalid" | "visual_observation_invalid" | "visual_artifact_invalid" | "visual_extraction_method_disabled" | "visual_extraction_low_confidence" | "visual_reader_user_takeover")[];
                } | null;
                lastErrorCode: ("visual_reader_not_enabled" | "visual_reader_session_expired" | "visual_reader_budget_exhausted" | "visual_source_invalid" | "visual_observation_invalid" | "visual_artifact_invalid" | "visual_extraction_method_disabled" | "visual_extraction_low_confidence" | "visual_reader_user_takeover") | null;
                sessionCount: number;
                /** @enum {string} */
                aggregateStatus: "active" | "succeeded" | "partial_success" | "failed" | "stopped";
                aggregateUsage: {
                    videoCount: number;
                    observationCount: number;
                    scrollCount: number;
                    ocrCallCount: number;
                    domObservationCount: number;
                    accessibilityObservationCount: number;
                    ocrObservationCount: number;
                    lowConfidenceObservationCount: number;
                    artifactCount: number;
                };
                visualSteps: {
                    /** @enum {string} */
                    id: "authorize_visual_reader" | "read_visible_comment_cards" | "extract_visible_text" | "persist_visual_observations" | "review_visual_signal_confidence";
                    /** @enum {string} */
                    status: "pending" | "running" | "succeeded" | "partial_success" | "failed" | "skipped";
                    /** Format: date-time */
                    startedAt: null | string;
                    /** Format: date-time */
                    completedAt: null | string;
                    durationMs: null | number;
                    processedCount: number;
                    errorCode: ("visual_reader_not_enabled" | "visual_reader_session_expired" | "visual_reader_budget_exhausted" | "visual_source_invalid" | "visual_observation_invalid" | "visual_artifact_invalid" | "visual_extraction_method_disabled" | "visual_extraction_low_confidence" | "visual_reader_user_takeover") | null;
                    message: string;
                }[];
            };
            commentSignals: {
                eventId: string;
                candidateId: string;
                displayName: string;
                handle: null | string;
                text: string;
                /** Format: date-time */
                occurredAt: string;
                likeCount: number;
                replyCount: number;
                ipLabel: null | string;
                /** Format: uri */
                sourceUrl: string;
                /** @enum {string} */
                intentBand: "strong_signal" | "potential_signal" | "noise" | "negative";
                reasons: string[];
                confidence: number;
                /** @enum {string} */
                identityStatus: "resolved" | "needs_research";
                evidenceId: string;
            }[];
            candidateEvents: {
                eventId: string;
                /** Format: date-time */
                createdAt: string;
                candidateId: string;
                candidate: {
                    id: string;
                    /** @enum {string} */
                    subjectKind: "organization" | "individual";
                    displayName: string;
                    industry: null | string;
                    region: null | string;
                    domain: null | string;
                    status: string;
                    version: number;
                    identityResolved: boolean;
                    /** Format: date-time */
                    updatedAt: string;
                };
                qualification: null | {
                    id: string;
                    candidateId: string;
                    decisionVersion: string;
                    /** @enum {string} */
                    decisionEngine: "model" | "rules";
                    /** @enum {string} */
                    grade: "S" | "A" | "B" | "C" | "D";
                    score: number;
                    /** @enum {string} */
                    recommendedAction: "priority_review" | "public_response" | "nurture" | "observe" | "do_not_contact";
                    evidence: {
                        evidenceId: string;
                        excerpt: string;
                    }[];
                    positiveSignals: {
                        name: string;
                        score: number;
                    }[];
                    negativeSignals: {
                        name: string;
                        score: number;
                    }[];
                    reasons: string[];
                    confidence: number;
                    ruleVersion: string;
                    promptVersion: null | string;
                    modelProvider: null | string;
                    model: null | string;
                    hardGateFailures: ("missing_original_source" | "identity_unresolved" | "do_not_contact" | "explicit_rejection" | "non_public_or_sensitive_data" | "stale_evidence" | "schema_invalid")[];
                    /** Format: date-time */
                    createdAt: string;
                };
                financialValue: null | {
                    id: string;
                    candidateId: string;
                    qualificationDecisionId: string;
                    version: string;
                    /** @enum {string} */
                    grade: "S" | "A" | "B" | "C" | "D";
                    score: number;
                    currency: string;
                    expectedRevenueMinor: number;
                    expectedGrossProfitMinor: number;
                    expectedContributionMinor: number;
                    factors: {
                        profitability: number;
                        cashFlow: number;
                        creditQuality: number;
                        repeatPotential: number;
                        referralPotential: number;
                        closeProbability: number;
                    };
                    /** Format: date-time */
                    createdAt: string;
                };
                sourcePlatforms: string[];
                evidenceCount: number;
            }[];
            nextAfter: string;
            hasMore: boolean;
        };
        visualReaderIdentifier: string;
        visualReaderCreateRequest: {
            runId: components["schemas"]["visualReaderIdentifier"];
            artifactUploadEnabled: boolean;
        };
        /** @enum {string} */
        visualReaderStableErrorCode: "visual_reader_not_enabled" | "visual_reader_session_expired" | "visual_reader_budget_exhausted" | "visual_source_invalid" | "visual_observation_invalid" | "visual_artifact_invalid" | "visual_extraction_method_disabled" | "visual_extraction_low_confidence" | "visual_reader_user_takeover";
        visualReaderOutcome: {
            /** @enum {string} */
            status: "completed" | "partial_success" | "aborted" | "expired";
            videoCount: number;
            observationCount: number;
            domObservationCount: number;
            accessibilityObservationCount: number;
            ocrObservationCount: number;
            lowConfidenceObservationCount: number;
            artifactCount: number;
            errorCodes: components["schemas"]["visualReaderStableErrorCode"][];
        };
        visualReaderLimits: {
            maxVideos: number;
            maxCommentsPerVideo: number;
            maxScrolls: number;
            maxOcrCalls: number;
            maxDurationMs: number;
        };
        visualReaderUsage: {
            videoCount: number;
            observationCount: number;
            scrollCount: number;
            ocrCallCount: number;
            domObservationCount: number;
            accessibilityObservationCount: number;
            ocrObservationCount: number;
            lowConfidenceObservationCount: number;
            artifactCount: number;
        };
        /**
         * VisualReaderSession
         * @description Server-owned public projection for one explicitly authorized, bounded, read-only visual reader session.
         */
        visualReaderSession: {
            sessionId: components["schemas"]["visualReaderIdentifier"];
            runId: components["schemas"]["visualReaderIdentifier"];
            planId: components["schemas"]["visualReaderIdentifier"];
            planVersionId: components["schemas"]["visualReaderIdentifier"];
            /** @constant */
            platform: "douyin";
            /** @constant */
            coverage: "authorized_visible_top_level_sample";
            /** @enum {string} */
            status: "created" | "collecting" | "completed" | "partial_success" | "aborted" | "expired";
            artifactUploadEnabled: boolean;
            limits: components["schemas"]["visualReaderLimits"];
            usage: components["schemas"]["visualReaderUsage"];
            outcome: components["schemas"]["visualReaderOutcome"] | null;
            lastErrorCode: components["schemas"]["visualReaderStableErrorCode"] | null;
            /** Format: date-time */
            createdAt: string;
            /** Format: date-time */
            authorizedAt: string;
            /** Format: date-time */
            updatedAt: string;
            /** Format: date-time */
            expiresAt: string;
            completedAt: string | null;
        } & ({
            /** @enum {unknown} */
            status?: "created" | "collecting";
            outcome?: null;
            completedAt?: null;
        } | {
            /** @constant */
            status?: "completed";
            outcome?: components["schemas"]["visualReaderOutcome"] & {
                /** @constant */
                status?: "completed";
            };
            /** Format: date-time */
            completedAt?: string;
        } | {
            /** @constant */
            status?: "partial_success";
            outcome?: components["schemas"]["visualReaderOutcome"] & {
                /** @constant */
                status?: "partial_success";
            };
            /** Format: date-time */
            completedAt?: string;
        } | {
            /** @constant */
            status?: "aborted";
            outcome?: components["schemas"]["visualReaderOutcome"] & {
                /** @constant */
                status?: "aborted";
            };
            /** Format: date-time */
            completedAt?: string;
        } | {
            /** @constant */
            status?: "expired";
            outcome?: components["schemas"]["visualReaderOutcome"] & {
                /** @constant */
                status?: "expired";
            };
            /** Format: date-time */
            completedAt?: string;
        });
        /** Format: uri */
        visualObservationSourceUrl: string;
        visualObservationVideoId: string;
        visualObservationVisibleText: string;
        visualObservationDigest: string;
        visualObservationNullableDigest: components["schemas"]["visualObservationDigest"] | null;
        visualObservationNullableVisibleString: string | null;
        visualObservationNullableCount: number | null;
        visualObservationNullablePlatformCommentId: string | null;
        visualObservationNullablePublicProfileUrl: string | null;
        visualObservationNullableSecUid: string | null;
        /** @enum {string} */
        visualObservationExtractionMethod: "dom" | "accessibility" | "ocr" | "vision";
        visualObservationFieldConfidences: {
            visibleText: number;
            displayName?: number;
            visibleTimeText?: number;
            likeCount?: number;
            replyCount?: number;
            platformCommentId?: number;
            publicProfileUrl?: number;
            secUid?: number;
        };
        visualObservationCardBounds: {
            x: number;
            y: number;
            width: number;
            height: number;
        };
        visualObservationReaderVersion: string;
        /** Format: date-time */
        visualObservationCapturedAt: string;
        /** @description Canonical base64 whose decoded length is at most 262144 bytes. Actual WebP decoding and pixel proof validation are Task 3 service responsibilities. */
        visualReaderBoundedWebpBase64: string;
        visualReaderPixelRect: {
            x: number;
            y: number;
            width: number;
            height: number;
        };
        visualReaderOpaqueRectRedactionProof: {
            /** @constant */
            version: "opaque-rect-v1";
            /** @constant */
            maskColorRgba: [
                17,
                61,
                51,
                255
            ];
            avatarBounds: components["schemas"]["visualReaderPixelRect"] | null;
            visibleRegions: components["schemas"]["visualReaderPixelRect"][];
            maskedRegions: components["schemas"]["visualReaderPixelRect"][];
        };
        visualReaderObservationSubmission: {
            clientObservationKey: components["schemas"]["visualReaderIdentifier"];
            sourceUrl: components["schemas"]["visualObservationSourceUrl"];
            videoId: components["schemas"]["visualObservationVideoId"];
            visibleText: components["schemas"]["visualObservationVisibleText"];
            domTextHash: components["schemas"]["visualObservationNullableDigest"];
            ocrTextHash: components["schemas"]["visualObservationNullableDigest"];
            displayName: components["schemas"]["visualObservationNullableVisibleString"];
            visibleTimeText: components["schemas"]["visualObservationNullableVisibleString"];
            likeCount: components["schemas"]["visualObservationNullableCount"];
            replyCount: components["schemas"]["visualObservationNullableCount"];
            platformCommentId: components["schemas"]["visualObservationNullablePlatformCommentId"];
            publicProfileUrl: components["schemas"]["visualObservationNullablePublicProfileUrl"];
            secUid: components["schemas"]["visualObservationNullableSecUid"];
            extractionMethod: components["schemas"]["visualObservationExtractionMethod"];
            fieldConfidences: components["schemas"]["visualObservationFieldConfidences"];
            viewport: {
                width: number;
                height: number;
                deviceScaleFactor: number;
            };
            cardBounds: components["schemas"]["visualObservationCardBounds"];
            readerVersion: components["schemas"]["visualObservationReaderVersion"];
            capturedAt: components["schemas"]["visualObservationCapturedAt"];
            redactedCrop: {
                /** @constant */
                mediaType: "image/webp";
                contentBase64: components["schemas"]["visualReaderBoundedWebpBase64"];
                redactionProof: components["schemas"]["visualReaderOpaqueRectRedactionProof"];
            } | null;
        };
        /** @description At most 20 client observations, with no more than five redacted crops. */
        visualReaderObservationBatchRequest: {
            observations: components["schemas"]["visualReaderObservationSubmission"][];
        };
        visualObservationIdentifier: string;
        /**
         * DouyinVisualCommentObservationV1
         * @description Server-normalized observation of one currently visible top-level Douyin comment. Standard JSON Schema validates sourceUrl and videoId independently; the Task 3 service must require the numeric sourceUrl video segment to equal videoId before persistence.
         */
        douyinVisualCommentObservation: {
            observationId: components["schemas"]["visualObservationIdentifier"];
            sessionId: components["schemas"]["visualObservationIdentifier"];
            sourceUrl: components["schemas"]["visualObservationSourceUrl"];
            videoId: components["schemas"]["visualObservationVideoId"];
            visibleText: components["schemas"]["visualObservationVisibleText"];
            textHash: components["schemas"]["visualObservationDigest"];
            domTextHash: components["schemas"]["visualObservationNullableDigest"];
            ocrTextHash: components["schemas"]["visualObservationNullableDigest"];
            displayName: components["schemas"]["visualObservationNullableVisibleString"];
            visibleTimeText: components["schemas"]["visualObservationNullableVisibleString"];
            likeCount: components["schemas"]["visualObservationNullableCount"];
            replyCount: components["schemas"]["visualObservationNullableCount"];
            platformCommentId: components["schemas"]["visualObservationNullablePlatformCommentId"];
            /** @description Literal public profile link fact only. Standard JSON Schema validates it independently; the Task 3 service must verify its public user key agrees with secUid before persistence. */
            publicProfileUrl: components["schemas"]["visualObservationNullablePublicProfileUrl"];
            secUid: components["schemas"]["visualObservationNullableSecUid"];
            extractionMethod: components["schemas"]["visualObservationExtractionMethod"];
            fieldConfidences: components["schemas"]["visualObservationFieldConfidences"];
            viewportHash: components["schemas"]["visualObservationDigest"];
            cardBounds: components["schemas"]["visualObservationCardBounds"];
            redactedCropHash: components["schemas"]["visualObservationDigest"] | null;
            readerVersion: components["schemas"]["visualObservationReaderVersion"];
            capturedAt: components["schemas"]["visualObservationCapturedAt"];
        };
        visualReaderAcceptedObservation: {
            clientObservationKey: components["schemas"]["visualReaderIdentifier"];
            observation: components["schemas"]["douyinVisualCommentObservation"];
        };
        /** @description Accepted observations are server-normalized facts. Standard JSON Schema validates each sessionId independently; the Task 3 service must require the route, session, and every observation sessionId to agree before returning the response. */
        visualReaderObservationBatchResponse: {
            session: components["schemas"]["visualReaderSession"];
            accepted: components["schemas"]["visualReaderAcceptedObservation"][];
            duplicates: components["schemas"]["visualReaderIdentifier"][];
        };
        visualReaderCompleteRequest: {
            /** @enum {string} */
            status: "completed" | "partial_success";
            errorCodes: components["schemas"]["visualReaderStableErrorCode"][];
        };
        visualReaderAbortRequest: {
            /** @enum {string} */
            reasonCode: "user_requested" | "visual_reader_user_takeover";
        };
        /** OrganizationCandidate */
        "organization-candidate.v1.schema": {
            id: string;
            name: string;
            domain: string | null;
            region: string | null;
            creditCode: string | null;
            evidenceIds: string[];
            /** @constant */
            subjectKind: "organization";
            version: number;
            identityResolved: boolean;
            /** @enum {unknown} */
            status: "discovered" | "unresolvable" | "normalized" | "qualified" | "pending_review" | "approved" | "rejected" | "do_not_contact" | "needs_research" | "converted_to_lead";
            latestDecisionVersion: string | null;
            approvedDecisionVersion: string | null;
            /** Format: date-time */
            updatedAt: string;
            /** Format: date-time */
            createdAt: string;
        };
        /** IndividualDemandSignal */
        "individual-demand-signal.v1.schema": {
            id: string;
            publicActorKey: string;
            publicDisplayName: string;
            /** Format: uri */
            publicProfileUrl: string;
            sourcePlatform: string;
            evidenceIds: string[];
            demandCategory: string;
            demandSummary: string;
            locationHint: string;
            /** @enum {unknown} */
            buyingStage: "awareness" | "problem_defined" | "solution_research" | "comparison" | "purchase_ready";
            negativeSignals: string[];
            /** @constant */
            subjectKind: "individual";
            version: number;
            identityResolved: boolean;
            /** @enum {unknown} */
            status: "discovered" | "unresolvable" | "normalized" | "qualified" | "pending_review" | "approved" | "rejected" | "do_not_contact" | "needs_research" | "converted_to_lead";
            latestDecisionVersion: string | null;
            approvedDecisionVersion: string | null;
            /** Format: date-time */
            updatedAt: string;
            /** Format: date-time */
            firstSeenAt: string;
            /** Format: date-time */
            lastSeenAt: string;
        } & unknown;
        /** CandidateIntelligenceOperation */
        "candidate-intelligence-operation.v1.schema": {
            id: string;
            candidateId: string;
            /** @enum {unknown} */
            status: "queued" | "running" | "succeeded" | "failed";
            /** @enum {unknown} */
            currentStage: "research" | "qualification" | "battle_card" | null;
            completedStages: ("research" | "qualification" | "battle_card")[];
            skippedStages: ("research" | "qualification" | "battle_card")[];
            research: {
                summary: string;
                findings: {
                    label: string;
                    content: string;
                    evidenceIds: string[];
                    confidence: number | null;
                }[];
            } | null;
            qualification: {
                /** @enum {unknown} */
                grade: "S" | "A" | "B" | "C" | "D";
                score: number;
                hardGateFailures: string[];
                financialValueId: string;
            } | null;
            battleCardId: string | null;
            failure: {
                /** @enum {unknown} */
                stage: "research" | "qualification" | "battle_card";
                errorCode: string;
            } | null;
            /** Format: date-time */
            createdAt: string;
            /** Format: date-time */
            startedAt: string | null;
            /** Format: date-time */
            updatedAt: string;
            /** Format: date-time */
            completedAt: string | null;
            /** Format: date-time */
            failedAt: string | null;
        };
        "douyin-identity-resolution-operation.v1.schema": {
            id: string;
            candidateId: string;
            candidateVersion: number;
            /** @enum {string} */
            status: "queued" | "running" | "succeeded" | "requires_review" | "failed";
            /** @enum {string|null} */
            currentStage: "public_page" | "independent_search" | "consensus_gate" | "identity_confirmation" | "intelligence_dispatch" | null;
            /** @enum {string|null} */
            outcome: "verified_consensus" | "not_found" | "insufficient_evidence" | "ambiguous" | "conflicting" | "access_restricted" | "redirect_not_allowed" | "stale_candidate" | "provider_unavailable" | null;
            retryable: boolean;
            canonicalProfileUrl: string | null;
            profileCandidates: {
                publicProfileUrl: string;
                evidenceIds: string[];
            }[];
            evidence: {
                evidenceId: string;
                /** @enum {string} */
                evidenceClass: "douyin_public_page" | "independent_search_result";
                publicProfileUrl: string;
                sourceUrl: string;
                sourceFingerprint: string;
                /** @enum {string} */
                accessStatus: "indexed_summary" | "public_content" | "access_restricted" | "redirect_not_allowed" | "provider_unavailable";
                /** Format: date-time */
                fetchedAt: string;
            }[];
            intelligenceOperationId: string | null;
            /** Format: date-time */
            createdAt: string;
            /** Format: date-time */
            updatedAt: string;
            /** Format: date-time */
            completedAt: string | null;
        };
        /** QualificationDecision */
        "qualification-decision.v1.schema": {
            /** @enum {unknown} */
            decisionEngine: "model" | "rules";
            /** @enum {unknown} */
            grade: "S" | "A" | "B" | "C" | "D";
            score: number;
            /** @enum {unknown} */
            recommendedAction: "priority_review" | "public_response" | "nurture" | "observe" | "do_not_contact";
            evidence: {
                evidenceId: string;
                excerpt?: string;
            }[];
            positiveSignals: {
                name: string;
                score: number;
            }[];
            negativeSignals: {
                name: string;
                score: number;
            }[];
            reasons: string[];
            confidence: number;
            ruleVersion: string;
            promptVersion: string | null;
            modelProvider: string | null;
            model: string | null;
        } & unknown;
        /** FinancialValueDecision */
        "financial-value-decision.v1.schema": {
            id: string;
            candidateId: string;
            qualificationDecisionId: string;
            version: string;
            /** @enum {unknown} */
            grade: "S" | "A" | "B" | "C" | "D";
            score: number;
            currency: string;
            expectedRevenueMinor: number;
            expectedGrossProfitMinor: number;
            expectedContributionMinor: number;
            factors: {
                profitability: number;
                cashFlow: number;
                creditQuality: number;
                repeatPotential: number;
                referralPotential: number;
                closeProbability: number;
            };
            /** Format: date-time */
            createdAt: string;
        };
        /** BattleCard */
        "battle-card.v1.schema": {
            id: string;
            candidateId: string;
            qualificationDecisionId: string;
            /** @enum {unknown} */
            partyType: "organization" | "individual";
            /** @constant */
            schemaVersion: "battle-card.v1";
            intelligence: null;
            sections: ({
                label: string;
                /** @enum {unknown} */
                kind: "fact" | "inference" | "unknown";
                content: string;
                evidenceIds?: string[];
                confidence?: number | null;
            } & unknown)[];
            evidenceIds: string[];
            confidence: number;
            modelProvider: string;
            model: string;
            promptVersion: string;
            /** Format: date-time */
            createdAt: string;
        };
        claim: {
            /** @enum {unknown} */
            kind: "fact" | "inference" | "unknown";
            text: string;
            evidenceIds: string[];
            confidence: number | null;
        } & (unknown & unknown & unknown);
        factors: {
            profitability: number;
            cashFlow: number;
            creditQuality: number;
            repeatPotential: number;
            referralPotential: number;
            closeProbability: number;
        };
        buyingRole: {
            role: string;
            /** @enum {unknown} */
            priority: 1 | 2 | 3;
            /** @enum {unknown} */
            influence: "decision_maker" | "influencer" | "user" | "gatekeeper";
            concerns: string[];
            claim: components["schemas"]["claim"];
        };
        connectionStrategy: {
            /** @enum {unknown} */
            channel: "public_reply" | "wecom" | "phone" | "email" | "referral";
            targetRole: string;
            rationale: components["schemas"]["claim"];
            openingDraft: string;
        };
        roleOpener: {
            role: string;
            /** @enum {unknown} */
            channel: "public_reply" | "wecom" | "phone" | "email" | "referral";
            text: string;
        };
        financialSummary: {
            decisionId: string;
            decisionVersion: string;
            /** @enum {unknown} */
            grade: "S" | "A" | "B" | "C" | "D";
            score: number;
            currency: string;
            expectedRevenueMinor: number;
            expectedGrossProfitMinor: number;
            expectedContributionMinor: number;
            factors: components["schemas"]["factors"];
        };
        intelligence: {
            accountOverview: components["schemas"]["claim"][];
            needAssessment: components["schemas"]["claim"][];
            supplierHypotheses: components["schemas"]["claim"][];
            buyingCommittee: components["schemas"]["buyingRole"][];
            procurementPreferences: components["schemas"]["claim"][];
            connectionStrategies: components["schemas"]["connectionStrategy"][];
            roleSpecificOpeners: components["schemas"]["roleOpener"][];
            doNotActions: string[];
            financialSummary: components["schemas"]["financialSummary"] | null;
        };
        /** BattleCardV2 */
        "battle-card.v2.schema": {
            id: string;
            candidateId: string;
            qualificationDecisionId: string;
            /** @enum {unknown} */
            partyType: "organization" | "individual";
            /** @constant */
            schemaVersion: "battle-card.v2";
            intelligence: components["schemas"]["intelligence"];
            evidenceIds: string[];
            confidence: number;
            modelProvider: string;
            model: string;
            promptVersion: string;
            /** Format: date-time */
            createdAt: string;
            $defs: {
                claim: {
                    /** @enum {unknown} */
                    kind: "fact" | "inference" | "unknown";
                    text: string;
                    evidenceIds: string[];
                    confidence: number | null;
                } & (unknown & unknown & unknown);
                buyingRole: {
                    role: string;
                    /** @enum {unknown} */
                    priority: 1 | 2 | 3;
                    /** @enum {unknown} */
                    influence: "decision_maker" | "influencer" | "user" | "gatekeeper";
                    concerns: string[];
                    claim: components["schemas"]["claim"];
                };
                connectionStrategy: {
                    /** @enum {unknown} */
                    channel: "public_reply" | "wecom" | "phone" | "email" | "referral";
                    targetRole: string;
                    rationale: components["schemas"]["claim"];
                    openingDraft: string;
                };
                roleOpener: {
                    role: string;
                    /** @enum {unknown} */
                    channel: "public_reply" | "wecom" | "phone" | "email" | "referral";
                    text: string;
                };
                factors: {
                    profitability: number;
                    cashFlow: number;
                    creditQuality: number;
                    repeatPotential: number;
                    referralPotential: number;
                    closeProbability: number;
                };
                financialSummary: {
                    decisionId: string;
                    decisionVersion: string;
                    /** @enum {unknown} */
                    grade: "S" | "A" | "B" | "C" | "D";
                    score: number;
                    currency: string;
                    expectedRevenueMinor: number;
                    expectedGrossProfitMinor: number;
                    expectedContributionMinor: number;
                    factors: components["schemas"]["factors"];
                };
                intelligence: {
                    accountOverview: components["schemas"]["claim"][];
                    needAssessment: components["schemas"]["claim"][];
                    supplierHypotheses: components["schemas"]["claim"][];
                    buyingCommittee: components["schemas"]["buyingRole"][];
                    procurementPreferences: components["schemas"]["claim"][];
                    connectionStrategies: components["schemas"]["connectionStrategy"][];
                    roleSpecificOpeners: components["schemas"]["roleOpener"][];
                    doNotActions: string[];
                    financialSummary: components["schemas"]["financialSummary"] | null;
                };
            };
        };
        /** ReviewEvent */
        "review-event.v1.schema": {
            id: string;
            candidateId: string;
            decisionVersion: string;
            /** @enum {unknown} */
            action: "approved" | "rejected" | "do_not_contact" | "needs_research" | "reopen";
            reason?: string | null;
            reviewerId: string;
            idempotencyKey: string;
            /** Format: date-time */
            createdAt: string;
        };
        /** PartyRef */
        "party-ref.v1.schema": {
            /** @constant */
            partyType: "organization";
            organizationId: string;
            tenantProspectId: string;
        } | {
            /** @constant */
            partyType: "individual";
            individualPartyId: string;
            demandSignalId: string;
        };
        amount: {
            amountMinor: number;
            currency: string;
        };
        organizationPartyRef: {
            /** @constant */
            partyType: "organization";
            organizationId: string;
            tenantProspectId: string;
        };
        individualPartyRef: {
            /** @constant */
            partyType: "individual";
            individualPartyId: string;
            demandSignalId: string;
        };
        liveAttribution: {
            /** @constant */
            attributionVersion: "acquisition-run.v1";
            runId: string;
            planId: string;
            planVersionId: string;
            planVersion: number;
            planSnapshotHash: string;
            discoveredEventId: string;
            /** Format: date-time */
            discoveredAt: string;
            shardId: string;
            operationId: string;
            connectionId: string;
            providerId: string;
            evidenceIds: string[];
            providerIds: string[];
            queryIds: string[];
            strategyVersion: string;
            qualificationDecisionId: string;
            decisionVersion: string;
            decisionSnapshotHash: string;
            /** @enum {unknown} */
            decisionEngine: "model" | "rules";
            ruleVersion: string;
            modelProvider: string | null;
            model: string | null;
            promptVersion: string | null;
        };
        legacyAttribution: {
            runId: string | null;
            evidenceIds: string[];
            providerIds: string[];
            queryIds: string[];
            strategyVersion: string | null;
            qualificationDecisionId: string | null;
            decisionVersion: string | null;
            decisionSnapshotHash: string | null;
            /** @enum {unknown} */
            decisionEngine: "model" | "rules" | null;
            ruleVersion: string | null;
            modelProvider: string | null;
            model: string | null;
            promptVersion: string | null;
        };
        /** OutcomeFeedback */
        "outcome-feedback.v1.schema": {
            $defs: {
                organizationPartyRef: {
                    /** @constant */
                    partyType: "organization";
                    organizationId: string;
                    tenantProspectId: string;
                };
                individualPartyRef: {
                    /** @constant */
                    partyType: "individual";
                    individualPartyId: string;
                    demandSignalId: string;
                };
                amount: {
                    amountMinor: number;
                    currency: string;
                };
                liveAttribution: {
                    /** @constant */
                    attributionVersion: "acquisition-run.v1";
                    runId: string;
                    planId: string;
                    planVersionId: string;
                    planVersion: number;
                    planSnapshotHash: string;
                    discoveredEventId: string;
                    /** Format: date-time */
                    discoveredAt: string;
                    shardId: string;
                    operationId: string;
                    connectionId: string;
                    providerId: string;
                    evidenceIds: string[];
                    providerIds: string[];
                    queryIds: string[];
                    strategyVersion: string;
                    qualificationDecisionId: string;
                    decisionVersion: string;
                    decisionSnapshotHash: string;
                    /** @enum {unknown} */
                    decisionEngine: "model" | "rules";
                    ruleVersion: string;
                    modelProvider: string | null;
                    model: string | null;
                    promptVersion: string | null;
                };
                legacyAttribution: {
                    runId: string | null;
                    evidenceIds: string[];
                    providerIds: string[];
                    queryIds: string[];
                    strategyVersion: string | null;
                    qualificationDecisionId: string | null;
                    decisionVersion: string | null;
                    decisionSnapshotHash: string | null;
                    /** @enum {unknown} */
                    decisionEngine: "model" | "rules" | null;
                    ruleVersion: string | null;
                    modelProvider: string | null;
                    model: string | null;
                    promptVersion: string | null;
                };
            };
        } & ({
            id: string;
            ownerId: string;
            teamId: string;
            leadId: string | null;
            customerId: string | null;
            /** @enum {unknown} */
            eventType: "validated" | "contacted" | "replied" | "rejected" | "do_not_contact" | "private_domain_entered" | "need_confirmed" | "quoted" | "won" | "lost" | "payment_received";
            /** Format: date-time */
            occurredAt: string;
            amount: components["schemas"]["amount"] | null;
            reasonCode: string | null;
            reasonText: string | null;
            idempotencyKey: string;
            createdBy: string;
            /** Format: date-time */
            createdAt: string;
            /** @constant */
            recordKind: "live";
            partyRef: components["schemas"]["organizationPartyRef"] | components["schemas"]["individualPartyRef"];
            candidateId: string;
            attribution: components["schemas"]["liveAttribution"];
        } | {
            id: string;
            ownerId: string;
            teamId: string;
            leadId: string | null;
            customerId: string | null;
            /** @enum {unknown} */
            eventType: "validated" | "contacted" | "replied" | "rejected" | "do_not_contact" | "private_domain_entered" | "need_confirmed" | "quoted" | "won" | "lost" | "payment_received";
            /** Format: date-time */
            occurredAt: string;
            amount: components["schemas"]["amount"] | null;
            reasonCode: string | null;
            reasonText: string | null;
            idempotencyKey: string;
            createdBy: string;
            /** Format: date-time */
            createdAt: string;
            /** @constant */
            recordKind: "legacy_migrated";
            legacySourceId: string;
            partyRef: components["schemas"]["organizationPartyRef"] | null;
            candidateId: string | null;
            attribution: components["schemas"]["legacyAttribution"];
            migrationWarnings: string[];
        });
        /** CopilotSession */
        "copilot-session.v1.schema": {
            id: string;
            ownerId: string;
            teamId: string;
            /** @enum {unknown} */
            status: "active" | "completed" | "failed";
            modelSnapshot: {
                connectionId: string;
                credentialVersion: number;
                provider: string;
                model: string;
                promptVersion: string;
                schemaVersion: string;
                promptHash: string;
                schemaHash: string;
            };
            /** Format: date-time */
            createdAt: string;
        };
        textContent: {
            /** @constant */
            type: "text";
            text: string;
            textSignature?: string;
        };
        imageContent: {
            /** @constant */
            type: "image";
            data: string;
            mimeType: string;
        };
        thinkingContent: {
            /** @constant */
            type: "thinking";
            thinking: string;
            thinkingSignature?: string;
            redacted?: boolean;
        };
        toolCall: {
            /** @constant */
            type: "toolCall";
            id: string;
            name: string;
            arguments: {
                [key: string]: unknown;
            };
            thoughtSignature?: string;
        };
        inputContent: components["schemas"]["textContent"] | components["schemas"]["imageContent"];
        assistantContent: components["schemas"]["textContent"] | components["schemas"]["thinkingContent"] | components["schemas"]["toolCall"];
        usage: {
            input: number;
            output: number;
            cacheRead: number;
            cacheWrite: number;
            cacheWrite1h?: number;
            reasoning?: number;
            totalTokens: number;
            cost: {
                input: number;
                output: number;
                cacheRead: number;
                cacheWrite: number;
                total: number;
            };
        };
        /** CopilotMessage */
        "copilot-message.v1.schema": {
            id: string;
            sessionId: string;
            sequence: number;
            message: {
                /** @constant */
                role: "user";
                content: string | components["schemas"]["inputContent"][];
                timestamp: number;
            } | {
                /** @constant */
                role: "assistant";
                content: components["schemas"]["assistantContent"][];
                api: string;
                provider: string;
                model: string;
                responseModel?: string;
                responseId?: string;
                diagnostics?: unknown[];
                usage: components["schemas"]["usage"];
                /** @enum {unknown} */
                stopReason: "stop" | "length" | "toolUse" | "error" | "aborted";
                errorMessage?: string;
                timestamp: number;
            } | {
                /** @constant */
                role: "toolResult";
                toolCallId: string;
                toolName: string;
                content: components["schemas"]["inputContent"][];
                details?: unknown;
                usage?: components["schemas"]["usage"];
                addedToolNames?: string[];
                isError: boolean;
                timestamp: number;
            };
            /** Format: date-time */
            createdAt: string;
            $defs: {
                textContent: {
                    /** @constant */
                    type: "text";
                    text: string;
                    textSignature?: string;
                };
                imageContent: {
                    /** @constant */
                    type: "image";
                    data: string;
                    mimeType: string;
                };
                thinkingContent: {
                    /** @constant */
                    type: "thinking";
                    thinking: string;
                    thinkingSignature?: string;
                    redacted?: boolean;
                };
                toolCall: {
                    /** @constant */
                    type: "toolCall";
                    id: string;
                    name: string;
                    arguments: {
                        [key: string]: unknown;
                    };
                    thoughtSignature?: string;
                };
                inputContent: components["schemas"]["textContent"] | components["schemas"]["imageContent"];
                assistantContent: components["schemas"]["textContent"] | components["schemas"]["thinkingContent"] | components["schemas"]["toolCall"];
                usage: {
                    input: number;
                    output: number;
                    cacheRead: number;
                    cacheWrite: number;
                    cacheWrite1h?: number;
                    reasoning?: number;
                    totalTokens: number;
                    cost: {
                        input: number;
                        output: number;
                        cacheRead: number;
                        cacheWrite: number;
                        total: number;
                    };
                };
            };
        };
        /** CopilotTask */
        "copilot-task.v1.schema": {
            id: string;
            sessionId: string;
            /** @constant */
            kind: "message";
            /** @enum {unknown} */
            status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
            /** @enum {unknown} */
            responseMode: "assistant" | "plan_draft";
            /** @enum {unknown} */
            targetPlatform?: "douyin" | "web";
            result: {
                [key: string]: unknown;
            } | null;
            errorCode: string | null;
            /** Format: date-time */
            createdAt: string;
            /** Format: date-time */
            completedAt: string | null;
        };
        /** ModelProvider */
        "model-provider.v1.schema": {
            /** @enum {unknown} */
            id: "openai" | "moonshot" | "minimax" | "zhipu" | "deepseek" | "qwen" | "doubao" | "hunyuan" | "qianfan";
            displayName: string;
            protocol: string;
        };
        /** DiscoveryProvider */
        "discovery-provider.v1.schema": {
            id: string;
            /** @enum {unknown} */
            kind: "search" | "content_fetch" | "import";
            displayName: string;
            capabilities: string[];
        };
        /** AcquisitionOperationShard */
        "acquisition-operation-shard.v1.schema": {
            id: string;
            runId: string;
            parentShardId: string | null;
            /** @enum {unknown} */
            kind: "search" | "content_fetch" | "import_rows";
            sourceRef: string;
            budgetSnapshotId: string;
            allocatedBudget: {
                requests: number;
                results: number;
                amountMinor: number;
                durationSeconds: number;
            };
            consumedBudget: {
                requests: number;
                results: number;
                amountMinor: number;
                durationSeconds: number;
            };
            /** @enum {unknown} */
            status: "queued" | "running" | "retry_scheduled" | "pause_requested" | "paused" | "cancel_requested" | "cancelled" | "succeeded" | "succeeded_empty" | "partial_success" | "failed" | "budget_exhausted";
        };
        boundedString: string;
        /** @description Canonical immutable SHA-256 digest: sha256: followed by exactly 64 lowercase hexadecimal characters. */
        digest: string;
        snapshotRef: {
            id: components["schemas"]["boundedString"];
            hash: components["schemas"]["digest"];
        };
        limit: {
            limit: number | null;
            remaining: number | null;
            /** Format: date-time */
            resetsAt: string | null;
        };
        /** PlatformConnection */
        "platform-connection.v1.schema": {
            id: components["schemas"]["boundedString"];
            tenantId: components["schemas"]["boundedString"];
            teamId: components["schemas"]["boundedString"] | null;
            connectorId: components["schemas"]["boundedString"];
            platform: string;
            platformAccountRef: components["schemas"]["boundedString"];
            scopes: string[];
            credentialVersion: number;
            sync: {
                /** @enum {unknown} */
                mode: "webhook" | "poll" | "hybrid" | "disabled";
                cursor: string | null;
            };
            /** @enum {unknown} */
            status: "pending" | "active" | "reauthorization_required" | "revoked" | "disabled" | "error";
            /** Format: date-time */
            authorizationExpiresAt: string | null;
            limits: {
                [key: string]: components["schemas"]["limit"];
            };
            /** @description Null only before the first capability capture; active connections require a current snapshot reference. */
            capabilitySnapshotRef: components["schemas"]["snapshotRef"] | null;
            createdBy: components["schemas"]["boundedString"];
            /** Format: date-time */
            createdAt: string;
            /** Format: date-time */
            updatedAt: string;
            $defs: {
                boundedString: string;
                /** @description Canonical immutable SHA-256 digest: sha256: followed by exactly 64 lowercase hexadecimal characters. */
                digest: string;
                snapshotRef: {
                    id: components["schemas"]["boundedString"];
                    hash: components["schemas"]["digest"];
                };
                limit: {
                    limit: number | null;
                    remaining: number | null;
                    /** Format: date-time */
                    resetsAt: string | null;
                };
            };
        } & unknown;
        capability: {
            /** @enum {unknown} */
            status: "available" | "unavailable" | "authorization_required" | "temporarily_unavailable";
            scopes: string[];
            limitRefs: string[];
            reasonCode: string | null;
        };
        /** @description Extensible identifier: 1-100 ASCII characters, starting with alphanumeric and continuing with alphanumeric, dot, underscore, colon, or hyphen. */
        extensibleIdentifier: string;
        /** PlatformCapabilitySnapshot */
        "platform-capability-snapshot.v1.schema": {
            id: components["schemas"]["boundedString"];
            tenantId: components["schemas"]["boundedString"];
            teamId: components["schemas"]["boundedString"] | null;
            connectionId: components["schemas"]["boundedString"];
            credentialVersion: number;
            snapshotHash: components["schemas"]["digest"];
            /** Format: date-time */
            capturedAt: string;
            /** Format: date-time */
            expiresAt: string;
            capturedBy: components["schemas"]["boundedString"];
            capabilities: {
                [key: string]: components["schemas"]["capability"];
            };
            $defs: {
                boundedString: string;
                /** @description Canonical immutable SHA-256 digest: sha256: followed by exactly 64 lowercase hexadecimal characters. */
                digest: string;
                /** @description Extensible identifier: 1-100 ASCII characters, starting with alphanumeric and continuing with alphanumeric, dot, underscore, colon, or hyphen. */
                extensibleIdentifier: string;
                capability: {
                    /** @enum {unknown} */
                    status: "available" | "unavailable" | "authorization_required" | "temporarily_unavailable";
                    scopes: string[];
                    limitRefs: string[];
                    reasonCode: string | null;
                };
            };
        };
        /** PlatformEvent */
        "platform-event.v1.schema": {
            id: components["schemas"]["boundedString"];
            tenantId: components["schemas"]["boundedString"];
            teamId: components["schemas"]["boundedString"] | null;
            platform: string;
            platformAccountRef: components["schemas"]["boundedString"];
            platformContentRef: components["schemas"]["boundedString"];
            platformEventRef: components["schemas"]["boundedString"];
            platformSubjectRef: components["schemas"]["boundedString"];
            eventType: string;
            rawPayloadHash: components["schemas"]["digest"];
            normalizedEventHash: components["schemas"]["digest"];
            /** Format: date-time */
            occurredAt: string;
            /** Format: date-time */
            capturedAt: string;
            authorizationSnapshot: {
                connectionId: components["schemas"]["boundedString"];
                credentialVersion: number;
                scopeHash: components["schemas"]["digest"];
                capabilitySnapshotRef: components["schemas"]["snapshotRef"];
            };
            dedupeKey: string;
            /** @enum {unknown} */
            accessStatus: "available" | "restricted" | "deleted" | "authorization_revoked";
            capturedBy: components["schemas"]["boundedString"];
            $defs: {
                boundedString: string;
                /** @description Canonical immutable SHA-256 digest: sha256: followed by exactly 64 lowercase hexadecimal characters. */
                digest: string;
                snapshotRef: {
                    id: components["schemas"]["boundedString"];
                    hash: components["schemas"]["digest"];
                };
            };
        };
        "$defs-digest": string;
        nullableBoundedString: components["schemas"]["boundedString"] | null;
        /**
         * DouyinCommentEvent
         * @description Immutable concrete payload for a publicly accessible top-level Douyin comment sample. Its platformEventId, videoId, and actor identifier populate the generic platform event envelope references.
         */
        "douyin-comment-event.v1.schema": {
            eventId: components["schemas"]["boundedString"];
            /** @constant */
            platform: "douyin";
            /** @constant */
            eventType: "comment";
            platformEventId: components["schemas"]["boundedString"];
            videoId: components["schemas"]["boundedString"];
            parentCommentId: null;
            text: string;
            textHash: components["schemas"]["$defs-digest"];
            /** Format: date-time */
            occurredAt: string;
            /** Format: date-time */
            capturedAt: string;
            likeCount: number;
            replyCount: number;
            ipLabel: components["schemas"]["nullableBoundedString"];
            actor: {
                displayName: components["schemas"]["boundedString"];
                handle: components["schemas"]["nullableBoundedString"];
                secUid: components["schemas"]["nullableBoundedString"];
            };
            /** Format: uri */
            sourceUrl: string;
            /** @constant */
            coverage: "public_top_level_sample";
            /** @constant */
            accessStatus: "public_content";
            providerVersion: components["schemas"]["boundedString"];
            rawArtifactHash: components["schemas"]["$defs-digest"];
            $defs: {
                boundedString: string;
                nullableBoundedString: components["schemas"]["boundedString"] | null;
                digest: string;
            };
        };
        planRef: {
            id: components["schemas"]["boundedString"];
            version: number;
            hash: components["schemas"]["digest"];
        };
        ruleBundleRef: {
            id: components["schemas"]["boundedString"];
            version: string;
            hash: components["schemas"]["digest"];
        };
        /** ActionPolicy */
        "action-policy.v1.schema": {
            id: components["schemas"]["boundedString"];
            tenantId: components["schemas"]["boundedString"];
            teamId: components["schemas"]["boundedString"] | null;
            version: number;
            planRef: components["schemas"]["planRef"];
            ruleBundleRef: components["schemas"]["ruleBundleRef"];
            policyHash: components["schemas"]["digest"];
            actions: {
                [key: string]: "auto_allowed" | "review_required" | "blocked";
            };
            /** Format: date-time */
            effectiveAt: string;
            /** Format: date-time */
            expiresAt: string | null;
            createdBy: components["schemas"]["boundedString"];
            /** Format: date-time */
            createdAt: string;
            $defs: {
                boundedString: string;
                /** @description Canonical immutable SHA-256 digest: sha256: followed by exactly 64 lowercase hexadecimal characters. */
                digest: string;
                /** @description Extensible identifier: 1-100 ASCII characters, starting with alphanumeric and continuing with alphanumeric, dot, underscore, colon, or hyphen. */
                extensibleIdentifier: string;
                planRef: {
                    id: components["schemas"]["boundedString"];
                    version: number;
                    hash: components["schemas"]["digest"];
                };
                ruleBundleRef: {
                    id: components["schemas"]["boundedString"];
                    version: string;
                    hash: components["schemas"]["digest"];
                };
            };
        };
        normalizedError: {
            /** @enum {unknown} */
            category: "capability_unavailable" | "authorization_insufficient" | "quota_exhausted" | "rate_limited" | "temporary_error" | "permanent_error" | "result_unknown";
            code: string;
            message: string;
            retryable: boolean;
        };
        immutableRef: {
            id: components["schemas"]["boundedString"];
            hash: components["schemas"]["digest"];
        };
        /** ActionReceipt */
        "action-receipt.v1.schema": {
            id: components["schemas"]["boundedString"];
            tenantId: components["schemas"]["boundedString"];
            teamId: components["schemas"]["boundedString"] | null;
            intentRef: components["schemas"]["immutableRef"];
            decisionRef: components["schemas"]["immutableRef"];
            jobRef: {
                id: components["schemas"]["boundedString"];
                attempt: number;
            };
            connectionRef: {
                id: components["schemas"]["boundedString"];
                credentialVersion: number;
            };
            capabilitySnapshotRef: components["schemas"]["immutableRef"];
            /** @description Bounded idempotency key containing at least one non-whitespace character. */
            idempotencyKey: string;
            externalId: components["schemas"]["boundedString"] | null;
            /** @enum {unknown} */
            outcome: "succeeded" | "failed" | "unknown";
            error: components["schemas"]["normalizedError"] | null;
            requestHash: components["schemas"]["digest"];
            resultHash: components["schemas"]["digest"];
            /** Format: date-time */
            requestedAt: string;
            /** Format: date-time */
            completedAt: string;
            /** Format: date-time */
            recordedAt: string;
            recordedBy: components["schemas"]["boundedString"];
            $defs: {
                boundedString: string;
                /** @description Canonical immutable SHA-256 digest: sha256: followed by exactly 64 lowercase hexadecimal characters. */
                digest: string;
                immutableRef: {
                    id: components["schemas"]["boundedString"];
                    hash: components["schemas"]["digest"];
                };
                normalizedError: {
                    /** @enum {unknown} */
                    category: "capability_unavailable" | "authorization_insufficient" | "quota_exhausted" | "rate_limited" | "temporary_error" | "permanent_error" | "result_unknown";
                    code: string;
                    message: string;
                    retryable: boolean;
                };
            };
        } & unknown;
    };
    responses: never;
    parameters: {
        id: string;
        cursor: string;
        limit: number;
        candidateId: string;
        idempotencyKey: string;
        /** @description 租户作用域内的写入幂等键；原文不会持久化。 */
        planIdempotencyKey: string;
        ifMatch: string;
        acquisitionId: string;
        acquisitionCursor: string;
        acquisitionLimit: number;
        candidateIfMatch: string;
        presentationAfter: string;
        presentationLimit: number;
    };
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
    listAcquisitionProviders: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Discovery provider catalog */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            id: string;
                            /** @enum {string} */
                            kind: "search" | "content_fetch" | "import";
                            displayName: string;
                            /** Format: uri */
                            officialDocsUrl?: string;
                            /** Format: uri */
                            defaultBaseUrl?: string;
                            requiresKey?: boolean;
                            keyHint?: string;
                            costNote?: string;
                            capabilities: string[];
                        }[];
                        nextCursor: string | null;
                    };
                };
            };
            /** @description Unified API error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    listAcquisitionProviderConnections: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Provider connections */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: components["schemas"]["provider-connection.v1.schema"][];
                        nextCursor: string | null;
                    };
                };
            };
            /** @description Unified API error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    createAcquisitionProviderConnection: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["idempotencyKey"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    providerId: string;
                    /** @description 客户自己的官方 API Key，仅加密保存且永不回显。 */
                    apiKey: string;
                    /** Format: uri */
                    baseUrl?: string;
                    /**
                     * @default active
                     * @enum {string}
                     */
                    status?: "active" | "disabled";
                };
            };
        };
        responses: {
            /** @description Idempotent replay */
            200: {
                headers: {
                    "Idempotency-Replayed"?: "true";
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["provider-connection.v1.schema"];
                };
            };
            /** @description Provider connection created */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["provider-connection.v1.schema"];
                };
            };
            /** @description Unified API error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    getAcquisitionProviderConnection: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Provider connection */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["provider-connection.v1.schema"];
                };
            };
            /** @description Unified API error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    deleteAcquisitionProviderConnection: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Provider connection deleted */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Unified API error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    updateAcquisitionProviderConnection: {
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
                "application/json": {
                    /** @description 客户自己的官方 API Key，仅加密保存且永不回显。 */
                    apiKey: string;
                    /** Format: uri */
                    baseUrl?: string;
                    /** @enum {string} */
                    status?: "active" | "disabled";
                } | {
                    /** @enum {string} */
                    status: "active" | "disabled";
                };
            };
        };
        responses: {
            /** @description Provider connection updated */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["provider-connection.v1.schema"];
                };
            };
            /** @description Unified API error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    testAcquisitionProviderConnection: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Provider connection health check */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        ok: boolean;
                        message: string;
                        errorCode: string | null;
                        retryable: boolean;
                        /** Format: date-time */
                        retryAfterAt: string | null;
                        usage: string;
                    };
                };
            };
            /** @description Unified API error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    listAcquisitionContentFetchOperations: {
        parameters: {
            query?: {
                limit?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Content fetch operations */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ContentFetchOperationList"];
                };
            };
            /** @description Unified API error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    createAcquisitionContentFetchOperation: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["idempotencyKey"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /**
                     * Format: uri
                     * @description 仅允许公开 HTTPS URL。 运行时还会拒绝凭据、非默认端口、内网地址和敏感查询参数。
                     */
                    sourceUrl: string;
                    /** @enum {string} */
                    subjectChannel: "organization" | "individual";
                };
            };
        };
        responses: {
            /** @description Content fetch operation accepted */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["content-fetch-operation.v1.schema"];
                };
            };
            /** @description Unified API error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    getAcquisitionContentFetchOperation: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Content fetch operation */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["content-fetch-operation.v1.schema"];
                };
            };
            /** @description Unified API error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    listAcquisitionImportOperations: {
        parameters: {
            query?: {
                limit?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Import operations */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ImportOperationList"];
                };
            };
            /** @description Unified API error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    createAcquisitionImportOperation: {
        parameters: {
            query: {
                fileName: string;
                subjectChannel: "organization" | "individual";
                mapping: string;
            };
            header: {
                "Idempotency-Key": components["parameters"]["idempotencyKey"];
            };
            path?: never;
            cookie?: never;
        };
        /** @description Raw CSV/XLSX only; application/json returns 415 unsupported_media_type. */
        requestBody: {
            content: {
                "text/csv": string;
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": string;
                "application/octet-stream": string;
            };
        };
        responses: {
            /** @description Import operation accepted */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["import-operation.v1.schema"];
                };
            };
            /** @description Unified API error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            415: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    getAcquisitionImportOperation: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Import operation */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["import-operation.v1.schema"];
                };
            };
            /** @description Unified API error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    getAcquisitionEvidence: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["acquisitionId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Discovery evidence */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["discovery-evidence.v1.schema"];
                };
            };
            /** @description Unified API error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    createAcquisitionPlan: {
        parameters: {
            query?: never;
            header: {
                /** @description 租户作用域内的写入幂等键；原文不会持久化。 */
                "Idempotency-Key": components["parameters"]["planIdempotencyKey"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @enum {string} */
                    targetPlatform?: "douyin" | "web";
                    douyinPublicCommentSample?: {
                        enabled: boolean;
                        maxVideosPerRun: number;
                        maxCommentsPerVideo: number;
                        maxPagesPerVideo: number;
                    };
                    name: string;
                    objective: string;
                    icp: {
                        industries: string[];
                        regions: string[];
                        organizationCriteria: string[];
                        individualCriteria: string[];
                        exclusionRules: string[];
                    };
                    subjectChannels: {
                        organization: boolean;
                        individual: boolean;
                    };
                    providerConnections: {
                        connectionId: string;
                        providerId: string;
                        /** @enum {string} */
                        kind: "search" | "content_fetch" | "import";
                        /** @enum {string} */
                        status: "active" | "inactive" | "disabled";
                        credentialVersion: number;
                    }[];
                    operations: {
                        operationId: string;
                        /** @enum {string} */
                        subjectChannel: "organization" | "individual";
                        /** @enum {string} */
                        kind: "search" | "content_fetch" | "import_rows";
                        connectionId: string;
                        query?: string;
                        sourceRef?: string;
                        allocatedBudget: {
                            requests: number;
                            results: number;
                            amountMinor: number;
                            durationSeconds: number;
                        };
                    }[];
                    budgetSnapshot: {
                        billingCurrency: string;
                        maxRequests: number;
                        maxResults: number;
                        maxAmountMinor: number;
                        maxDurationSeconds: number;
                    };
                    /** @description 可选 BYOK 模型连接；服务端据此绑定不可伪造的模型快照。 */
                    modelConnectionId?: string | null;
                    stopConditions: {
                        stopWhenBudgetExhausted: boolean;
                        stopWhenNoMoreResults: boolean;
                    };
                } & unknown;
            };
        };
        responses: {
            /** @description Acquisition plan created */
            201: {
                headers: {
                    ETag: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["acquisition-plan.v1.schema"];
                };
            };
            /** @description Unified API error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    getAcquisitionPlan: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Acquisition plan */
            200: {
                headers: {
                    ETag: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["acquisition-plan.v1.schema"];
                };
            };
            /** @description Unified API error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    updateAcquisitionPlan: {
        parameters: {
            query?: never;
            header: {
                "If-Match": components["parameters"]["ifMatch"];
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @enum {string} */
                    targetPlatform?: "douyin" | "web";
                    douyinPublicCommentSample?: {
                        enabled: boolean;
                        maxVideosPerRun: number;
                        maxCommentsPerVideo: number;
                        maxPagesPerVideo: number;
                    };
                    name?: string;
                    objective?: string;
                    icp?: {
                        industries: string[];
                        regions: string[];
                        organizationCriteria: string[];
                        individualCriteria: string[];
                        exclusionRules: string[];
                    };
                    subjectChannels?: {
                        organization: boolean;
                        individual: boolean;
                    };
                    providerConnections?: {
                        connectionId: string;
                        providerId: string;
                        /** @enum {string} */
                        kind: "search" | "content_fetch" | "import";
                        /** @enum {string} */
                        status: "active" | "inactive" | "disabled";
                        credentialVersion: number;
                    }[];
                    operations?: {
                        operationId: string;
                        /** @enum {string} */
                        subjectChannel: "organization" | "individual";
                        /** @enum {string} */
                        kind: "search" | "content_fetch" | "import_rows";
                        connectionId: string;
                        query?: string;
                        sourceRef?: string;
                        allocatedBudget: {
                            requests: number;
                            results: number;
                            amountMinor: number;
                            durationSeconds: number;
                        };
                    }[];
                    budgetSnapshot?: {
                        billingCurrency: string;
                        maxRequests: number;
                        maxResults: number;
                        maxAmountMinor: number;
                        maxDurationSeconds: number;
                    };
                    modelSnapshotRef?: {
                        jobSnapshotId: string;
                        connectionId: string;
                        credentialVersion: number;
                        provider: string;
                        model: string;
                        capabilitySnapshotHash: string;
                        promptVersion: string;
                        schemaVersion: string;
                        promptHash: string;
                        schemaHash: string;
                    };
                    stopConditions?: {
                        stopWhenBudgetExhausted: boolean;
                        stopWhenNoMoreResults: boolean;
                    };
                };
            };
        };
        responses: {
            /** @description Acquisition plan updated */
            200: {
                headers: {
                    ETag: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["acquisition-plan.v1.schema"];
                };
            };
            /** @description Unified API error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            412: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            428: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    createAcquisitionPlanRevision: {
        parameters: {
            query?: never;
            header: {
                "If-Match": components["parameters"]["ifMatch"];
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @enum {string} */
                    targetPlatform?: "douyin" | "web";
                    douyinPublicCommentSample?: {
                        enabled: boolean;
                        maxVideosPerRun: number;
                        maxCommentsPerVideo: number;
                        maxPagesPerVideo: number;
                    };
                    name?: string;
                    objective?: string;
                    icp?: {
                        industries: string[];
                        regions: string[];
                        organizationCriteria: string[];
                        individualCriteria: string[];
                        exclusionRules: string[];
                    };
                    subjectChannels?: {
                        organization: boolean;
                        individual: boolean;
                    };
                    providerConnections?: {
                        connectionId: string;
                        providerId: string;
                        /** @enum {string} */
                        kind: "search" | "content_fetch" | "import";
                        /** @enum {string} */
                        status: "active" | "inactive" | "disabled";
                        credentialVersion: number;
                    }[];
                    operations?: {
                        operationId: string;
                        /** @enum {string} */
                        subjectChannel: "organization" | "individual";
                        /** @enum {string} */
                        kind: "search" | "content_fetch" | "import_rows";
                        connectionId: string;
                        query?: string;
                        sourceRef?: string;
                        allocatedBudget: {
                            requests: number;
                            results: number;
                            amountMinor: number;
                            durationSeconds: number;
                        };
                    }[];
                    budgetSnapshot?: {
                        billingCurrency: string;
                        maxRequests: number;
                        maxResults: number;
                        maxAmountMinor: number;
                        maxDurationSeconds: number;
                    };
                    modelSnapshotRef?: {
                        jobSnapshotId: string;
                        connectionId: string;
                        credentialVersion: number;
                        provider: string;
                        model: string;
                        capabilitySnapshotHash: string;
                        promptVersion: string;
                        schemaVersion: string;
                        promptHash: string;
                        schemaHash: string;
                    };
                    stopConditions?: {
                        stopWhenBudgetExhausted: boolean;
                        stopWhenNoMoreResults: boolean;
                    };
                };
            };
        };
        responses: {
            /** @description Acquisition plan revision created */
            201: {
                headers: {
                    ETag: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["acquisition-plan.v1.schema"];
                };
            };
            /** @description Unified API error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            412: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            428: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    approveAcquisitionPlan: {
        parameters: {
            query?: never;
            header: {
                "If-Match": string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @enum {string} */
                    decision: "approve";
                    reason: string;
                };
            };
        };
        responses: {
            /** @description Acquisition plan approved */
            200: {
                headers: {
                    ETag: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["acquisition-plan.v1.schema"];
                };
            };
            /** @description Unified API error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            412: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            428: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    createAcquisitionRun: {
        parameters: {
            query?: never;
            header: {
                /** @description 租户作用域内的写入幂等键；原文不会持久化。 */
                "Idempotency-Key": components["parameters"]["planIdempotencyKey"];
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": {
                    parentRunId?: string;
                    reason?: string;
                };
            };
        };
        responses: {
            /** @description Acquisition run accepted */
            202: {
                headers: {
                    ETag: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["acquisition-run.v1.schema"];
                };
            };
            /** @description Unified API error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    getAcquisitionRun: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Acquisition run */
            200: {
                headers: {
                    ETag: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["acquisition-run.v1.schema"];
                };
            };
            /** @description Unified API error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    listAcquisitionRunShards: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Acquisition run shards */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PagedResult"];
                };
            };
            /** @description Unified API error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    getAcquisitionRunPresentation: {
        parameters: {
            query?: {
                after?: components["parameters"]["presentationAfter"];
                limit?: components["parameters"]["presentationLimit"];
            };
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Acquisition run presentation */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["acquisition-run-presentation.v1.schema"];
                };
            };
            /** @description Unified API error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    pauseAcquisitionRun: {
        parameters: {
            query?: never;
            header: {
                "If-Match": components["parameters"]["ifMatch"];
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    reason: string;
                };
            };
        };
        responses: {
            /** @description Acquisition run updated */
            200: {
                headers: {
                    ETag: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["acquisition-run.v1.schema"];
                };
            };
            /** @description Unified API error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            412: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            428: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    resumeAcquisitionRun: {
        parameters: {
            query?: never;
            header: {
                "If-Match": components["parameters"]["ifMatch"];
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    reason: string;
                };
            };
        };
        responses: {
            /** @description Acquisition run updated */
            200: {
                headers: {
                    ETag: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["acquisition-run.v1.schema"];
                };
            };
            /** @description Unified API error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            412: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            428: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    cancelAcquisitionRun: {
        parameters: {
            query?: never;
            header: {
                "If-Match": components["parameters"]["ifMatch"];
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    reason: string;
                };
            };
        };
        responses: {
            /** @description Acquisition run updated */
            200: {
                headers: {
                    ETag: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["acquisition-run.v1.schema"];
                };
            };
            /** @description Unified API error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            412: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            428: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    createAcquisitionVisualReaderSession: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["idempotencyKey"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["visualReaderCreateRequest"];
            };
        };
        responses: {
            /** @description Idempotent replay of an existing visual reader session */
            200: {
                headers: {
                    "Idempotency-Replayed": "true";
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["visualReaderSession"];
                };
            };
            /** @description Visual reader session created */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["visualReaderSession"];
                };
            };
            /** @description Unified API error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    getAcquisitionVisualReaderSession: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                sessionId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Visual reader session */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["visualReaderSession"];
                };
            };
            /** @description Unified API error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    appendAcquisitionVisualReaderObservationBatch: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["idempotencyKey"];
            };
            path: {
                sessionId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["visualReaderObservationBatchRequest"];
            };
        };
        responses: {
            /** @description Accepted and duplicate visual observations */
            200: {
                headers: {
                    "Idempotency-Replayed"?: "true";
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["visualReaderObservationBatchResponse"];
                };
            };
            /** @description Unified API error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    completeAcquisitionVisualReaderSession: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["idempotencyKey"];
            };
            path: {
                sessionId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["visualReaderCompleteRequest"];
            };
        };
        responses: {
            /** @description Completed visual reader session */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["visualReaderSession"];
                };
            };
            /** @description Unified API error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    abortAcquisitionVisualReaderSession: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["idempotencyKey"];
            };
            path: {
                sessionId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["visualReaderAbortRequest"];
            };
        };
        responses: {
            /** @description Aborted visual reader session */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["visualReaderSession"];
                };
            };
            /** @description Unified API error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    getAcquisitionVisualReaderArtifact: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                artifactId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Redacted WebP comment-card crop */
            200: {
                headers: {
                    "Cache-Control": "private, no-store";
                    "X-Content-Type-Options": "nosniff";
                    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; sandbox";
                    [name: string]: unknown;
                };
                content: {
                    "image/webp": string;
                };
            };
            /** @description Unified API error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    listAcquisitionCandidates: {
        parameters: {
            query?: {
                cursor?: components["parameters"]["acquisitionCursor"];
                limit?: components["parameters"]["acquisitionLimit"];
                subjectKind?: "organization" | "individual";
                status?: "discovered" | "unresolvable" | "normalized" | "qualified" | "pending_review" | "approved" | "rejected" | "do_not_contact" | "needs_research" | "converted_to_lead";
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Cursor-paginated candidates */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CandidatePagedResult"];
                };
            };
            /** @description Unified API error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    getAcquisitionCandidate: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["acquisitionId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Candidate */
            200: {
                headers: {
                    ETag: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Candidate"];
                };
            };
            /** @description Unified API error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    listAcquisitionCandidateEvidence: {
        parameters: {
            query?: {
                cursor?: components["parameters"]["acquisitionCursor"];
                limit?: components["parameters"]["acquisitionLimit"];
            };
            header?: never;
            path: {
                id: components["parameters"]["acquisitionId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Candidate evidence */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DiscoveryEvidencePagedResult"];
                };
            };
            /** @description Unified API error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    confirmAcquisitionCandidateIdentity: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["idempotencyKey"];
                "If-Match": components["parameters"]["candidateIfMatch"];
            };
            path: {
                id: components["parameters"]["acquisitionId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @enum {string} */
                    subjectKind: "organization";
                    domain: string | null;
                    creditCode: string | null;
                    evidenceIds: string[];
                    rationale: string;
                } | {
                    /** @enum {string} */
                    subjectKind: "individual";
                    /** Format: uri */
                    publicProfileUrl: string;
                    sourcePlatform: string;
                    evidenceIds: string[];
                    rationale: string;
                };
            };
        };
        responses: {
            /** @description Candidate identity confirmed */
            200: {
                headers: {
                    ETag: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["IdentityConfirmationResult"];
                };
            };
            /** @description Unified API error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            428: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    createAcquisitionCandidateIntelligenceOperation: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["idempotencyKey"];
            };
            path: {
                candidateId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": Record<string, never>;
            };
        };
        responses: {
            /** @description Candidate intelligence operation accepted */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["candidate-intelligence-operation.v1.schema"];
                };
            };
            /** @description Unified API error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    getAcquisitionCandidateIntelligenceOperation: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                operationId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Candidate intelligence operation */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["candidate-intelligence-operation.v1.schema"];
                };
            };
            /** @description Unified API error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    getLatestAcquisitionCandidateIntelligenceOperation: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                candidateId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Latest candidate intelligence operation */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["candidate-intelligence-operation.v1.schema"];
                };
            };
            /** @description Unified API error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    retryAcquisitionCandidateIntelligenceOperation: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["idempotencyKey"];
            };
            path: {
                operationId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": Record<string, never>;
            };
        };
        responses: {
            /** @description Candidate intelligence operation retry accepted */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["candidate-intelligence-operation.v1.schema"];
                };
            };
            /** @description Unified API error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    getLatestAcquisitionDouyinIdentityResolutionOperation: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                candidateId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Latest Douyin identity resolution operation */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["douyin-identity-resolution-operation.v1.schema"];
                };
            };
            /** @description Unified API error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    createAcquisitionDouyinIdentityResolutionOperation: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["idempotencyKey"];
            };
            path: {
                candidateId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": Record<string, never>;
            };
        };
        responses: {
            /** @description Douyin identity resolution operation accepted */
            202: {
                headers: {
                    /** @description Present with value true for an idempotent replay */
                    "Idempotency-Replayed"?: "true";
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["douyin-identity-resolution-operation.v1.schema"];
                };
            };
            /** @description Unified API error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    getAcquisitionCandidateQualification: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["acquisitionId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Qualification decision */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["qualification-decision.v1.schema"];
                };
            };
            /** @description Unified API error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    getAcquisitionCandidateFinancialValue: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["acquisitionId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Financial value decision */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["financial-value-decision.v1.schema"];
                };
            };
            /** @description Unified API error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    getAcquisitionCandidateBattleCard: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["acquisitionId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Battle card */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["BattleCard"];
                };
            };
            /** @description Unified API error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    listAcquisitionCandidateReviews: {
        parameters: {
            query?: {
                cursor?: components["parameters"]["acquisitionCursor"];
                limit?: components["parameters"]["acquisitionLimit"];
            };
            header?: never;
            path: {
                id: components["parameters"]["acquisitionId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Review events */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ReviewEventPagedResult"];
                };
            };
            /** @description Unified API error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    reviewAcquisitionCandidate: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["idempotencyKey"];
            };
            path: {
                id: components["parameters"]["acquisitionId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @enum {string} */
                    action: "approved" | "do_not_contact";
                    decisionVersion: string;
                    reason: string | null;
                } | {
                    /** @enum {string} */
                    action: "rejected" | "needs_research" | "reopen";
                    decisionVersion: string;
                    reason: string;
                };
            };
        };
        responses: {
            /** @description Candidate reviewed */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CandidateReviewResult"];
                };
            };
            /** @description Unified API error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    convertAcquisitionCandidate: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["idempotencyKey"];
            };
            path: {
                id: components["parameters"]["acquisitionId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    decisionVersion: string;
                };
            };
        };
        responses: {
            /** @description Candidate converted */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LeadConversion"];
                };
            };
            /** @description Unified API error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    listAcquisitionOutcomes: {
        parameters: {
            query: {
                cursor?: components["parameters"]["acquisitionCursor"];
                limit?: components["parameters"]["acquisitionLimit"];
                candidateId: components["parameters"]["candidateId"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Outcome feedback */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["OutcomeFeedbackPagedResult"];
                };
            };
            /** @description Unified API error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    getAcquisitionPerformance: {
        parameters: {
            query: {
                platform?: "douyin" | "web";
                from: string;
                to: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Acquisition performance */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AcquisitionPerformance"];
                };
            };
            /** @description Unified API error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    createAcquisitionCopilotSession: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["idempotencyKey"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    connectionId?: string | null;
                };
            };
        };
        responses: {
            /** @description Copilot session creation accepted */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["async-operation.v1.schema"];
                };
            };
            /** @description Unified API error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    getAcquisitionCopilotSession: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["acquisitionId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Copilot session */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["copilot-session.v1.schema"];
                };
            };
            /** @description Unified API error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    listAcquisitionCopilotMessages: {
        parameters: {
            query?: {
                cursor?: components["parameters"]["acquisitionCursor"];
                limit?: components["parameters"]["acquisitionLimit"];
            };
            header?: never;
            path: {
                id: components["parameters"]["acquisitionId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Copilot messages */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CopilotMessagePagedResult"];
                };
            };
            /** @description Unified API error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    sendAcquisitionCopilotMessage: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["idempotencyKey"];
            };
            path: {
                id: components["parameters"]["acquisitionId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    message: string;
                    /**
                     * @default assistant
                     * @enum {string}
                     */
                    responseMode?: "assistant" | "plan_draft";
                    /**
                     * @default web
                     * @enum {string}
                     */
                    targetPlatform?: "douyin" | "web";
                };
            };
        };
        responses: {
            /** @description Queued copilot task */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["copilot-task.v1.schema"];
                };
            };
            /** @description Unified API error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    getAcquisitionCopilotTask: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["acquisitionId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Copilot task */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["copilot-task.v1.schema"];
                };
            };
            /** @description Unified API error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    listAcquisitionAuditEvents: {
        parameters: {
            query?: {
                cursor?: components["parameters"]["acquisitionCursor"];
                limit?: components["parameters"]["acquisitionLimit"];
                candidateId?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Audit events */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AuditEventPagedResult"];
                };
            };
            /** @description Unified API error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            /** @description Unified API error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
}
