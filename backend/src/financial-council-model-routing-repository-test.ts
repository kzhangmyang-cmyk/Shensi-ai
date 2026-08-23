import { InMemoryFinancialCouncilModelRoutingRepository } from
  "./financial-council-model-routing-repository.js";
import { registerFinancialCouncilModelRoutingRepositoryContract } from
  "./financial-council-model-routing-repository-contract-test.js";

registerFinancialCouncilModelRoutingRepositoryContract("memory", () =>
  new InMemoryFinancialCouncilModelRoutingRepository());
