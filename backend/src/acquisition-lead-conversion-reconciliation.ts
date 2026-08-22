import type {
  AcquisitionDomainService
} from "./acquisition-domain-service.js";

export interface AcquisitionLeadConversionReconciliationServiceOptions {
  domainService: AcquisitionDomainService;
}

export class AcquisitionLeadConversionReconciliationService {
  readonly #domainService: AcquisitionDomainService;

  constructor(
    options: AcquisitionLeadConversionReconciliationServiceOptions
  ) {
    this.#domainService = options.domainService;
  }

  runOnce(options: { limit?: number } = {}) {
    return this.#domainService.reconcilePendingLeadConversions(
      options.limit ?? 50
    );
  }
}
