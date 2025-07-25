import type { GraphQLRequest } from '../../externalTypes/index.js';
import type { Logger } from '@apollo/utils.logger';
import type {
  SchemaReport,
  SchemaReportMutationVariables,
  SchemaReportMutation,
  ReportSchemaResponse,
} from './generated/operations';
import type { Fetcher } from '@apollo/utils.fetcher';
import { packageVersion } from '../../generated/packageVersion.js';

// Magic GraphQL comment allows codegen to find the query
// prettier-ignore
export const schemaReportGql = /* GraphQL */ `#graphql
  mutation SchemaReport($report: SchemaReport!, $coreSchema: String) {
    reportSchema(report: $report, coreSchema: $coreSchema) {
      __typename
      ... on ReportSchemaError {
        message
        code
      }
      ... on ReportSchemaResponse {
        inSeconds
        withCoreSchema
      }
    }
  }
`;

// This class is meant to be a thin shim around the gql mutations.
export class SchemaReporter {
  // These mirror the gql variables
  private readonly schemaReport: SchemaReport;
  private readonly coreSchema: string;
  private readonly endpointUrl: string;
  private readonly logger: Logger;
  private readonly initialReportingDelayInMs: number;
  private readonly fallbackReportingDelayInMs: number;
  private readonly fetcher: Fetcher;

  private isStopped: boolean;
  private pollTimer?: NodeJS.Timeout;
  private readonly headers: Record<string, string>;

  constructor(options: {
    schemaReport: SchemaReport;
    coreSchema: string;
    apiKey: string;
    endpointUrl: string | undefined;
    logger: Logger;
    initialReportingDelayInMs: number;
    fallbackReportingDelayInMs: number;
    fetcher?: Fetcher;
  }) {
    this.headers = {
      'Content-Type': 'application/json',
      'x-api-key': options.apiKey,
      'apollographql-client-name': 'ApolloServerPluginSchemaReporting',
      'apollographql-client-version': packageVersion,
    };

    this.endpointUrl =
      options.endpointUrl ||
      'https://schema-reporting.api.apollographql.com/api/graphql';

    this.schemaReport = options.schemaReport;
    this.coreSchema = options.coreSchema;
    this.isStopped = false;
    this.logger = options.logger;
    this.initialReportingDelayInMs = options.initialReportingDelayInMs;
    this.fallbackReportingDelayInMs = options.fallbackReportingDelayInMs;
    this.fetcher = options.fetcher ?? fetch;
  }

  public stopped(): boolean {
    return this.isStopped;
  }

  public start() {
    this.pollTimer = setTimeout(
      () => this.sendOneReportAndScheduleNext(false),
      this.initialReportingDelayInMs,
    );
  }

  public stop() {
    this.isStopped = true;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  private async sendOneReportAndScheduleNext(sendNextWithCoreSchema: boolean) {
    this.pollTimer = undefined;

    // Bail out permanently
    if (this.stopped()) return;
    try {
      const result = await this.reportSchema(sendNextWithCoreSchema);
      if (!result) {
        return;
      }
      if (!this.stopped()) {
        this.pollTimer = setTimeout(
          () => this.sendOneReportAndScheduleNext(result.withCoreSchema),
          result.inSeconds * 1000,
        );
      }
      return;
    } catch (error) {
      // In the case of an error we want to continue looping
      // We can add hardcoded backoff in the future,
      // or on repeated failures stop responding reporting.
      this.logger.error(
        `Error reporting server info to Apollo during schema reporting: ${error}`,
      );
      if (!this.stopped()) {
        this.pollTimer = setTimeout(
          () => this.sendOneReportAndScheduleNext(false),
          this.fallbackReportingDelayInMs,
        );
      }
    }
  }

  public async reportSchema(
    withCoreSchema: boolean,
  ): Promise<ReportSchemaResponse | null> {
    const { data, errors } = await this.apolloQuery({
      report: this.schemaReport,
      coreSchema: withCoreSchema ? this.coreSchema : null,
    });

    if (errors) {
      throw new Error(errors.map((x: any) => x.message).join('\n'));
    }

    function msgForUnexpectedResponse(data: any): string {
      return [
        'Unexpected response shape from Apollo when',
        'reporting schema. If this continues, please reach',
        'out to support@apollographql.com.',
        'Received response:',
        JSON.stringify(data),
      ].join(' ');
    }

    if (!data || !data.reportSchema) {
      throw new Error(msgForUnexpectedResponse(data));
    }

    if (data.reportSchema.__typename === 'ReportSchemaResponse') {
      return data.reportSchema;
    } else if (data.reportSchema.__typename === 'ReportSchemaError') {
      this.logger.error(
        [
          'Received input validation error from Apollo:',
          data.reportSchema.message,
          'Stopping reporting. Please fix the input errors.',
        ].join(' '),
      );
      this.stop();
      return null;
    }
    throw new Error(msgForUnexpectedResponse(data));
  }

  private async apolloQuery(
    variables: SchemaReportMutationVariables,
  ): Promise<{ data?: SchemaReportMutation; errors?: any[] }> {
    const request: GraphQLRequest = {
      query: schemaReportGql,
      variables,
    };

    const httpResponse = await this.fetcher(this.endpointUrl, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(request),
    });

    if (!httpResponse.ok) {
      throw new Error(
        [
          `An unexpected HTTP status code (${httpResponse.status}) was`,
          'encountered during schema reporting.',
        ].join(' '),
      );
    }

    try {
      // JSON parsing failure due to malformed data is the likely failure case
      // here.  Any non-JSON response (e.g. HTML) is usually the suspect.
      return await httpResponse.json();
    } catch (error) {
      throw new Error(
        [
          "Couldn't report schema to Apollo.",
          'Parsing response as JSON failed.',
          'If this continues please reach out to support@apollographql.com',
          error,
        ].join(' '),
      );
    }
  }
}
