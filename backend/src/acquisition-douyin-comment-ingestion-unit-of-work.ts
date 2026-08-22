import type mysql from "mysql2/promise";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  InMemoryAcquisitionDomainRepository
} from "./acquisition-domain-repository.js";
import {
  InMemoryAcquisitionDouyinCommentEventRepository
} from "./acquisition-douyin-comment-events.js";
import {
  MysqlAcquisitionDouyinCommentEventRepository
} from "./acquisition-douyin-comment-events-mysql-repository.js";
import {
  MysqlAcquisitionDomainRepository
} from "./acquisition-mysql-repositories.js";
import {
  isAcquisitionMysqlNamedLockReleaseError,
  poisonAcquisitionMysqlConnection,
  releaseAcquisitionMysqlConnection
} from "./acquisition-mysql-named-lock.js";
import {
  InMemoryAcquisitionCandidateDirectory,
  MysqlAcquisitionCandidateDirectory
} from "./acquisition-tool-support-repositories.js";
import type {
  InMemoryAcquisitionVisualReaderRepository
} from "./acquisition-visual-reader-sessions.js";
import type {
  MysqlAcquisitionVisualReaderRepository
} from "./acquisition-visual-reader-mysql-repository.js";

export interface AcquisitionDouyinCommentIngestionUnitOfWork {
  transaction<T>(work: () => Promise<T>): Promise<T>;
}

export class InMemoryAcquisitionDouyinCommentIngestionUnitOfWork
implements AcquisitionDouyinCommentIngestionUnitOfWork {
  constructor(
    private readonly domain: InMemoryAcquisitionDomainRepository,
    private readonly events: InMemoryAcquisitionDouyinCommentEventRepository,
    private readonly directory: InMemoryAcquisitionCandidateDirectory,
    private readonly visual?: InMemoryAcquisitionVisualReaderRepository
  ) {}

  transaction<T>(work: () => Promise<T>) {
    return this.directory.transaction(() =>
      this.domain.transaction(() => this.events.transaction(() =>
        this.visual ? this.visual.transaction(work) : work())));
  }
}

export class MysqlAcquisitionDouyinCommentIngestionUnitOfWork
implements AcquisitionDouyinCommentIngestionUnitOfWork {
  private readonly transactionContext =
    new AsyncLocalStorage<mysql.PoolConnection>();

  constructor(
    private readonly pool: mysql.Pool,
    private readonly domain: MysqlAcquisitionDomainRepository,
    private readonly events: MysqlAcquisitionDouyinCommentEventRepository,
    private readonly directory: MysqlAcquisitionCandidateDirectory,
    private readonly visual?: MysqlAcquisitionVisualReaderRepository
  ) {}

  async transaction<T>(work: () => Promise<T>) {
    if (this.transactionContext.getStore()) return work();
    const connection = await this.pool.getConnection();
    try {
      return await this.transactionContext.run(connection, () =>
        this.directory.withTransactionConnection(
          connection,
          () => this.domain.withTransactionConnection(connection, async () => {
            try {
              await connection.beginTransaction();
              const result = await this.events.withTransactionConnection(
                connection,
                () => this.visual
                  ? this.visual.withTransactionConnection(connection, work)
                  : work()
              );
              await connection.commit();
              return result;
            } catch (error) {
              try {
                await connection.rollback();
              } catch (rollbackError) {
                poisonAcquisitionMysqlConnection(connection);
                throw rollbackError;
              }
              throw error;
            }
          })
        )
      );
    } catch (error) {
      if (isAcquisitionMysqlNamedLockReleaseError(error)) {
        poisonAcquisitionMysqlConnection(connection);
      }
      throw error;
    } finally {
      releaseAcquisitionMysqlConnection(connection);
    }
  }
}
