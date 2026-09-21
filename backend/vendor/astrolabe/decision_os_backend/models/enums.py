from enum import StrEnum


class SimulationRunStatus(StrEnum):
    QUEUED = "queued"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"


class CompanyFinalOutcome(StrEnum):
    EXPLORE = "explore"
    SURVIVE = "survive"
    SUSTAINABLE = "sustainable"
    SCALABLE = "scalable"
    DEAD = "dead"


class ExperimentPlanDecision(StrEnum):
    GO = "go"
    ADJUST = "adjust"
    STOP = "stop"
