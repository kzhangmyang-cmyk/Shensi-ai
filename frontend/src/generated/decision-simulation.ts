export interface paths {
    "/api/v1/agent-memory/operating": paths["/api/v1/decision-simulations/memory"];
    "/api/v1/agent-memory/operating/export": paths["/api/v1/decision-simulations/memory/export"];
    "/api/v1/agent-memory/operating/profile": paths["/api/v1/decision-simulations/memory/profile"];
    "/api/v1/agent-memory/operating/reviews": paths["/api/v1/decision-simulations/memory/reviews"];
    "/api/v1/agent-memory/operating/adopt": paths["/api/v1/decision-simulations/memory/adopt"];
    "/api/v1/finance/operating-memory-question": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** @description Explicit current operating-domain personal preferences for a read-only specialist question. Existing finance authorization and source rules apply; never an acquisition command. */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": components["schemas"]["OperatingMemoryQuestion"];
                };
            };
            responses: {
                /** @description Read-only answer, optionally persisted in the existing CFO session */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["OperatingMemoryReply"];
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
    "/api/v1/decision-simulations/memory": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** @description Personal actor/workspace scoped encrypted preferences and manual reviews; no model calls. */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Current revision and personal records */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["DecisionMemory"];
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
    "/api/v1/decision-simulations/memory/export": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Complete personal memory export, excluding other actors and shared company documents */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["DecisionMemory"] & {
                            /** @enum {string} */
                            format: "shensi-personal-decision-memory.v1";
                            /** Format: date-time */
                            exportedAt: string;
                        };
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
    "/api/v1/decision-simulations/memory/profile": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /** @description Explicit replacement with CAS; disabled learning clears pending candidates. No historical report mutation. */
        put: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": components["schemas"]["DecisionProfileWrite"];
                };
            };
            responses: {
                /** @description Saved personal memory */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["DecisionMemory"];
                    };
                };
                /** @description Stale revision */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        post?: never;
        /** @description Remove profile contents and candidates; retain revision, manual reviews and immutable report snapshots. Reports currently have no individual deletion endpoint. */
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": components["schemas"]["DecisionMemoryRevision"];
                };
            };
            responses: {
                /** @description Profile removed */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["DecisionMemory"];
                    };
                };
                /** @description Stale revision */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/decision-simulations/memory/reviews": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /** @description Claim/plan and manually review an owned saved suggestion. Maximum 200 review records per actor/workspace. Does not complete advisor actions. Plan locks once results exist. */
        put: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": components["schemas"]["DecisionReviewWrite"];
                };
            };
            responses: {
                /** @description Saved manual review */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["DecisionMemory"];
                    };
                };
                /** @description Owned report or recommendation not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Stale revision */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/decision-simulations/memory/adopt": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** @description Explicitly adopt pending personal preference feedback only while learning is enabled; CAS applies to the entire personal memory. */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": components["schemas"]["DecisionCandidateAdoption"];
                };
            };
            responses: {
                /** @description Updated profile, candidate cleared */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["DecisionMemory"];
                    };
                };
                /** @description Stale revision */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/decision-simulations/preparations": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** @description Parse explicitly selected files without calling a model. Authenticated scope and cookie CSRF apply. Maximum combined binary size 5 MiB; preparations expire in one hour. */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": components["schemas"]["SourceInput"];
                };
            };
            responses: {
                /** @description Source references and unconfirmed baseline candidates */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Preparation"];
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
    "/api/v1/decision-simulations/preparations/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        get: {
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
                /** @description Actor scoped preparation and actual role execution state */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Preparation"];
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
    "/api/v1/decision-simulations/preparations/{id}/analyze": {
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
        /** @description Confirm corrected baseline and consent to sending selected source text to the configured model. Starts five role calls and a 100-path computation. Exact retries do not restart work. */
        post: {
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
                        /** @enum {boolean} */
                        confirm: true;
                        input: components["schemas"]["Input"];
                    };
                };
            };
            responses: {
                /** @description Accepted or replayed preparation */
                202: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Preparation"];
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
    "/api/v1/decision-simulations": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Actor and workspace scoped recent records */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ListItem"][];
                    };
                };
            };
        };
        put?: never;
        /** @description Explicitly calculate and save; same runId and same input replay, changed input conflicts. Cookie authentication and CSRF apply. */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": components["schemas"]["Input"];
                };
            };
            responses: {
                /** @description Persisted immutable record */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Record"];
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
    "/api/v1/decision-simulations/{runId}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                runId: string;
            };
            cookie?: never;
        };
        /** @description Read stored result only; never rerun or write a plan. */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    runId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Scoped record */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Record"];
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
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: {
        OperatingMemorySelection: {
            /** @enum {string} */
            domain: "operating";
            revision: number;
        };
        OperatingMemoryQuestion: {
            selection: components["schemas"]["OperatingMemorySelection"];
            input: components["schemas"]["$defs-Input"];
            session?: {
                /** Format: uuid */
                sessionId: string;
                revision: number;
            };
        };
        OperatingMemoryReply: {
            answer: components["schemas"]["cfo-conversation.v1.schema"];
            session?: {
                /** Format: uuid */
                sessionId: string;
                revision: number;
            };
        };
        DecisionMemoryRevision: {
            expectedRevision: number;
        };
        DecisionProfileWrite: {
            expectedRevision: number;
            enabled: boolean;
            preferences: components["schemas"]["DecisionPreferences"];
        };
        DecisionReviewPlan: {
            action: string;
            metric: string;
            unit: string;
            baseline: number;
            target: number;
            /** Format: date */
            dueDate: string;
            source: string;
        };
        DecisionReviewResult: {
            actual: number;
            /** Format: date */
            observedDate: string;
            source: string;
            attribution: string;
            /** @enum {string} */
            feedbackPriority?: "cash" | "profit" | "delivery";
        };
        DecisionReviewWrite: {
            expectedRevision: number;
            /** Format: uuid */
            runId: string;
            recommendationId: string;
            plan: components["schemas"]["DecisionReviewPlan"];
            result?: components["schemas"]["DecisionReviewResult"];
        };
        DecisionCandidateAdoption: {
            expectedRevision: number;
            /** Format: uuid */
            runId: string;
            recommendationId: string;
        };
        DecisionReview: {
            /** Format: uuid */
            runId: string;
            recommendationId: string;
            recommendationTitle: string;
            originalEvidence: string;
            originalAction: string;
            /** Format: date-time */
            claimedAt: string;
            /** Format: date-time */
            recordedAt: string;
            /** @enum {string} */
            state: "planned" | "reviewed";
            /** @enum {string} */
            sourceKind: "manual_observation";
            plan: components["schemas"]["DecisionReviewPlan"];
            result?: components["schemas"]["DecisionReviewResult"];
            comparison: {
                actualMinusTarget: number;
                actualMinusBaseline: number;
            } | null;
            /** @enum {string|null} */
            candidate: "cash" | "profit" | "delivery" | null;
        };
        DecisionMemory: {
            revision: number;
            /** Format: date-time */
            updatedAt: string | null;
            profile: {
                enabled: boolean;
                preferences: components["schemas"]["DecisionPreferences"];
            } | null;
            reviews: components["schemas"]["DecisionReview"][];
        };
        SourceInput: {
            /** @enum {string} */
            dataKind: "synthetic" | "user_defined";
            files: {
                fileName: string;
                /** @enum {string} */
                mediaType: "text/csv" | "application/vnd.ms-excel" | "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" | "application/pdf" | "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
                contentBase64: string;
            }[];
        };
        SourceFile: {
            fileName: string;
            fileHash: string;
            prefix: string;
        };
        SourceText: {
            sourceRef: string;
            text: string;
        };
        AgentResult: {
            /** @enum {string} */
            role: "founder" | "market" | "operations" | "finance" | "judge";
            /** @enum {string} */
            state: "queued" | "running" | "completed" | "insufficient" | "failed" | "cancelled";
            provider: string | null;
            model: string | null;
            errorCode: string | null;
            observations: {
                text: string;
                sourceRefs: string[];
            }[];
        };
        SourceFact: {
            /** @enum {string} */
            field: "cashMinor" | "monthlyOrders" | "backlogUnits" | "capacityUnits" | "priceMinor" | "unitCostMinor" | "fixedCostMinor" | "collectionMonths";
            label: string;
            /** @enum {string} */
            status: "missing" | "candidate" | "conflict";
            candidates: {
                value: number;
                sourceRefs: string[];
            }[];
        };
        AnalysisEvidence: {
            files: components["schemas"]["SourceFile"][];
            sources: components["schemas"]["SourceText"][];
            agents: components["schemas"]["AgentResult"][];
            uncertain: string[];
        };
        Preparation: {
            /** Format: uuid */
            id: string;
            /** Format: date-time */
            expiresAt: string;
            /** @enum {string} */
            dataKind: "synthetic" | "user_defined";
            /** @enum {string} */
            state: "awaiting_confirmation" | "analyzing" | "completed" | "failed" | "cancelled";
            files: components["schemas"]["SourceFile"][];
            sources: components["schemas"]["SourceText"][];
            facts: components["schemas"]["SourceFact"][];
            uncertain: string[];
            agents: components["schemas"]["AgentResult"][];
            runId: string | null;
            errorCode: string | null;
        };
        Scheduled: {
            dueMonth: number;
            amountMinor: number;
        };
        Baseline: {
            cashMinor: number;
            monthlyOrders: number;
            backlogUnits: number;
            capacityUnits: number;
            priceMinor: number;
            unitCostMinor: number;
            fixedCostMinor: number;
            collectionMonths: number;
            receivables: components["schemas"]["Scheduled"][];
            payables: components["schemas"]["Scheduled"][];
        };
        Plan: {
            id: string;
            demandMultiplier: number;
            capacityMultiplier: number;
            priceMultiplier: number;
            costMultiplier: number;
            extraFixedCostMinor: number;
        };
        Range: number[];
        Assumptions: {
            demand: components["schemas"]["Range"];
            procurement: components["schemas"]["Range"];
            collectionDelay: components["schemas"]["Range"];
            delivery: components["schemas"]["Range"];
            persistence: number;
            commonWeight: number;
        };
        /** @description Explicit scenario assumption, not a calibrated event probability. Active value replaces the corresponding background factor. Same-factor windows cannot overlap. */
        OperatingEvent: {
            /** @enum {string} */
            template: "staffing_shortage" | "staffing_recovery" | "sales_gain" | "sales_loss" | "cost_rise" | "cost_fall" | "payment_delay" | "payment_recovery";
            startMonth: number;
            durationMonths: number;
            value: number;
            probability: number;
            assumption: string;
        };
        RealizedEvent: {
            /** @enum {string} */
            template: "staffing_shortage" | "staffing_recovery" | "sales_gain" | "sales_loss" | "cost_rise" | "cost_fall" | "payment_delay" | "payment_recovery";
            startMonth: number;
            durationMonths: number;
            value: number;
            probability: number;
            assumption: string;
            backgroundValue: number;
        };
        Options: {
            seed: number;
            samples: number;
            months: number;
            assumptions: components["schemas"]["Assumptions"];
            events?: components["schemas"]["OperatingEvent"][];
        };
        DecisionPreferences: {
            /** @enum {string} */
            priority: "cash" | "profit" | "delivery";
            cashFloorMinor?: number;
            pilotFirst: boolean;
            /** @enum {string} */
            reviewCadence: "weekly" | "monthly";
            learningEnabled: boolean;
            /** @enum {string} */
            confirmedFrom: "self_report" | "explicit_feedback";
        };
        PreferenceAssessment: {
            /** @enum {string} */
            priority: "cash" | "profit" | "delivery";
            basis: string;
            plans: {
                planId: string;
                meetsCashFloor: boolean | null;
            }[];
        };
        Input: {
            /** Format: uuid */
            runId: string;
            title: string;
            /** @enum {string} */
            dataKind: "synthetic" | "user_defined";
            assumptionNote: string;
            decisionPreferences?: components["schemas"]["DecisionPreferences"];
            baseline: components["schemas"]["Baseline"];
            alternatives: components["schemas"]["Plan"][];
            options: components["schemas"]["Options"];
        };
        Shock: {
            demand: number;
            procurement: number;
            collectionDelay: number;
            delivery: number;
            events?: components["schemas"]["RealizedEvent"][];
        };
        Month: {
            month: number;
            orders: number;
            delivered: number;
            backlogUnits: number;
            revenueMinor: number;
            receiptsMinor: number;
            paymentsMinor: number;
            profitMinor: number;
            cashMinor: number;
            receivablesMinor: number;
            shock: components["schemas"]["Shock"];
        };
        Summary: {
            planId: string;
            sampleCount: number;
            profitRangeMinor: number[];
            worstMinimumCashMinor: number;
            samplesWithFundingGap: number;
            samplesWithBacklog: number;
            maximumBacklogUnits: number;
            pairedProfitDifferenceMinor: number[];
        };
        OperatingRecommendation: {
            id: string;
            title: string;
            /** @enum {string} */
            priority: "high" | "normal";
            /** @enum {string} */
            evidenceKind: "simulation_signal";
            evidence: string;
            evidenceRefs: string[];
            action: string;
            mechanism: string;
            costAndPrerequisites: string;
            ownerRole: string;
            timeframe: string;
            reviewMetric: string;
            /** @enum {string} */
            validation: "pilot_required";
            scenarioComparison?: {
                label: string;
                baselineProfitRangeMinor: number[];
                changedProfitRangeMinor: number[];
                baselineWorstCashMinor: number;
                changedWorstCashMinor: number;
            };
        };
        Report: {
            modelVersion: string;
            recommendations?: components["schemas"]["OperatingRecommendation"][];
            preferenceAssessment?: components["schemas"]["PreferenceAssessment"];
            plans: components["schemas"]["Summary"][];
            replays: {
                planId: string;
                modelVersion: string;
                samples: {
                    months: components["schemas"]["Month"][];
                    minimumCashMinor: number;
                    totalProfitMinor: number;
                    fundingGapMinor: number;
                }[];
            }[];
            sensitivity: {
                /** @enum {string} */
                factor: "demand" | "procurement" | "collectionDelay" | "delivery";
                /** @enum {string} */
                direction: "up" | "down";
                adjustment: string;
                plans: components["schemas"]["Summary"][];
            }[];
            threshold: {
                unitsForMonthlyOperatingBreakEven: number | null;
                withinBaselineCapacity: boolean;
                conditions: string;
            };
        };
        ListItem: {
            /** Format: uuid */
            runId: string;
            title: string;
            /** @enum {string} */
            dataKind: "synthetic" | "user_defined";
            createdAt: string;
        };
        Record: {
            /** Format: uuid */
            runId: string;
            createdAt: string;
            /** @enum {string} */
            recordVersion: "decision-simulation.v1";
            input: components["schemas"]["Input"];
            paths: components["schemas"]["Shock"][][];
            report: components["schemas"]["Report"];
            analysis?: components["schemas"]["AnalysisEvidence"];
        };
        Turn: {
            /** @enum {unknown} */
            role: "user" | "assistant";
            text: string;
        };
        "$defs-Input": {
            /**
             * Format: uuid
             * @description Required for a chat attachment: must match the conversation used when parsing it, together with the selected role.
             */
            conversationKey?: string;
            /** @description Exact actor/workspace-scoped read-only document selected by this conversation. Missing/expired IDs never fall back to a verified package. Null or omitted retains verified-package semantics. */
            documentId?: string | null;
            /**
             * @description Selected specialist; omitted means CFO. One role/model per question.
             * @default cfo
             * @enum {unknown}
             */
            role: "cfo" | "finance" | "profit" | "cost" | "cashflow" | "tax";
            question: string;
            history: components["schemas"]["Turn"][];
        };
        MaterialSource: {
            packageId: string;
            companyName: string;
            period: string;
            currency: string;
        };
        FileHash: string;
        /** @enum {unknown} */
        Classification: "financial_statements" | "ledger" | "unknown";
        /** @enum {unknown} */
        StatementKind: "balance_sheet" | "income_statement" | "cash_flow_statement";
        "$defs-MaterialSource": {
            /** @constant */
            kind: "readonly_document";
            documentId: string;
            fileName: string;
            fileHash: components["schemas"]["FileHash"];
            classification: components["schemas"]["Classification"];
            missingStatements: components["schemas"]["StatementKind"][];
            /** Format: date-time */
            expiresAt: string;
        };
        /** CfoConversationAnswer */
        "cfo-conversation.v1.schema": {
            answer: string;
            provider: string;
            model: string;
            material: null | components["schemas"]["MaterialSource"] | components["schemas"]["$defs-MaterialSource"];
            /** Format: date-time */
            answeredAt: string;
            $defs: {
                Input: {
                    /**
                     * Format: uuid
                     * @description Required for a chat attachment: must match the conversation used when parsing it, together with the selected role.
                     */
                    conversationKey?: string;
                    /** @description Exact actor/workspace-scoped read-only document selected by this conversation. Missing/expired IDs never fall back to a verified package. Null or omitted retains verified-package semantics. */
                    documentId?: string | null;
                    /**
                     * @description Selected specialist; omitted means CFO. One role/model per question.
                     * @default cfo
                     * @enum {unknown}
                     */
                    role: "cfo" | "finance" | "profit" | "cost" | "cashflow" | "tax";
                    question: string;
                    history: components["schemas"]["Turn"][];
                };
                Turn: {
                    /** @enum {unknown} */
                    role: "user" | "assistant";
                    text: string;
                };
                MaterialSource: {
                    packageId: string;
                    companyName: string;
                    period: string;
                    currency: string;
                };
            };
        };
    };
    responses: never;
    parameters: never;
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export type operations = Record<string, never>;
