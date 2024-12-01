import { Profile } from './Profile';
import {
  FilterCondition,
  FilterOperator,
  ProfileDocument,
  SearchCriteria,
} from './types';
import { Agent } from './Agent';
import { Contract } from './Contract';
import { Logger } from './Logger';
import { DataProvider, DataProviderType } from './DataProvider';
import { MongoDBProvider } from './MongoDBProvider';
import { MatchingService } from './MatchingService';
import { RecommendationService } from './RecommendationService';

export class ContractAgent extends Agent {
  private static instance: ContractAgent;

  private constructor() {
    super();
  }

  async prepare(): Promise<void> {
    this.loadDefaultConfiguration();
    await this.addDefaultProviders();
    this.setupProviderEventHandlers();
  }

  static async retrieveService(
    dataProviderType: DataProviderType = MongoDBProvider,
    refresh: boolean = false,
  ): Promise<ContractAgent> {
    if (!ContractAgent.instance || refresh) {
      DataProvider.setChildType(dataProviderType);
      const instance = new ContractAgent();
      await instance.prepare();
      ContractAgent.instance = instance;
    }
    return ContractAgent.instance;
  }

  protected enrichProfileWithSystemRecommendations(): Profile {
    throw new Error('Method not implemented.');
  }

  protected buildSearchCriteria(contract: Contract): SearchCriteria {
    const policies = contract.serviceOfferings
      .map((offering: { policies: any[] }) => {
        return offering.policies.map((policy) => policy.description);
      })
      .flat();

    return {
      conditions: [
        {
          field: 'recommendations.policies.policy',
          operator: FilterOperator.REGEX,
          value: policies,
        },
      ],
      threshold: 0.7,
      limit: 100,
    };
  }

  async findProfiles(
    source: string,
    criteria: SearchCriteria,
  ): Promise<Profile[]> {
    try {
      const dataProvider = this.getDataProvider(source);
      const results: ProfileDocument[] = await dataProvider.find(criteria);
      return results.map((result) => {
        const profil = {
          url: result.url,
          configurations: result.configurations,
          recommendations: result.recommendations || [],
          matching: result.matching || [],
          preference: result.preference || [],
        };
        return new Profile(profil);
      });
    } catch (error) {
      Logger.error(`Error while finding profile: ${(error as Error).message}`);
      throw new Error();
    }
  }

  async findProfilesAcrossProviders(
    criteria: SearchCriteria,
  ): Promise<Profile[]> {
    const allProfiles: Profile[] = [];
    if (this.config) {
      Logger.info(
        `Using data sources: ${this.config.dataProviderConfig
          .map((config) => config.source)
          .join(', ')}`,
      );
    }
    for (const dataProvider of this.dataProviders) {
      const { source } = dataProvider;
      if (source) {
        const profiles = await this.findProfiles(source, criteria);
        allProfiles.push(...profiles);
      } else {
        throw new Error('Provider "source" is undefined');
      }
    }
    return allProfiles;
  }

  private async updateProfileFromContractChange(
    contract: Contract,
  ): Promise<void> {
    if (!contract) {
      throw new Error('Contract is undefined');
    }
    await this.updateProfilesForMembers(contract);
    await this.updateProfilesForServiceOfferings(contract);
    await this.updateProfileForOrchestrator(contract);
  }

  private async updateProfilesForMembers(contract: Contract): Promise<void> {
    for (const member of contract.members) {
      await this.updateProfile(member.participant, contract);
    }
  }

  private async updateProfilesForServiceOfferings(
    contract: Contract,
  ): Promise<void> {
    for (const offering of contract.serviceOfferings) {
      await this.updateProfile(offering.participant, contract);
    }
  }

  private async updateProfileForOrchestrator(
    contract: Contract,
  ): Promise<void> {
    await this.updateProfile(contract.orchestrator, contract);
  }

  private async updateProfile(
    participantId: string,
    contract: Contract,
  ): Promise<void> {
    try {
      const profileProvider = this.dataProviders.find(
        (dataProvider) => dataProvider.source === 'profiles',
      );

      if (!profileProvider) {
        throw new Error('Profile DataProvider not found');
      }

      const conditions: FilterCondition = {
        field: 'url',
        operator: FilterOperator.EQUALS,
        value: participantId,
      };
      const criteria: SearchCriteria = {
        conditions: [conditions],
        threshold: 0,
      };

      const source = profileProvider.source;
      if (!source) {
        throw new Error('Provider "source" is undefined');
      }

      const profiles = await this.findProfiles(source, criteria);
      const profile =
        profiles[0] ??
        (await (async () => {
          Logger.warn('Profile not found, new one will be created...');
          return await this.createProfileForParticipant(participantId);
        })());

      await this.updateRecommendationForProfile(profile, contract);
      // update profile via matching service
      await this.updateMatchingForProfile(profile, contract);
    } catch (error) {
      Logger.error(`Update profile failed: ${(error as Error).message}`);
    }
  }

  protected async handleDataInserted(data: {
    fullDocument: any;
    source: string;
  }): Promise<void> {
    switch (data.source) {
      case 'contracts':
        try {
          await this.updateProfileFromContractChange(
            data.fullDocument as Contract,
          );
          Logger.info(`Data inserted for source: ${data.source}`);
        } catch (error) {
          Logger.error(`Data insertion failed: ${(error as Error).message}`);
        }
        break;
      default:
        Logger.info(`Unhandled data insertion for source: ${data.source}`);
    }
  }

  protected async handleDataUpdated(data: {
    documentKey: any;
    updateDescription: any;
    source: string;
  }): Promise<void> {
    switch (data.source) {
      case 'contracts':
        await this.updateProfileFromContractChange(
          data.updateDescription.updatedFields as Contract,
        );
        break;
      default:
        Logger.info(`Unhandled data update for source: ${data.source}`);
    }
  }

  protected handleDataDeleted(data: {
    documentKey: any;
    source: string;
  }): void {
    switch (data.source) {
      case 'contracts':
        Logger.info(`Removing contract: ${data.documentKey?._id}`);
        break;
      default:
        Logger.info(`Unhandled data deletion for source: ${data.source}`);
    }
  }

  protected async updateMatchingForProfile(
    profile: Profile,
    data: unknown,
  ): Promise<void> {
    const matchingService = MatchingService.retrieveService();
    await matchingService.updateProfile(profile, data);
  }

  protected async updateRecommendationForProfile(
    profile: Profile,
    data: unknown,
  ): Promise<void> {
    const recommendationService = RecommendationService.retrieveService();
    await recommendationService.updateProfile(profile, data);
  }
}
