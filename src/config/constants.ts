import constants from './constants.json';

export type NodeEnv = 'development' | 'test' | 'staging' | 'production';
export type NetworkType = 'testnet' | 'mainnet' | 'futurenet' | 'standalone';
export type DbDriverType = 'sqlite' | 'postgres';

export const REQUIRED_RUNTIME_VARS: readonly string[] = constants.REQUIRED_RUNTIME_VARS;
export const VALID_NODE_ENVS: readonly NodeEnv[] = constants.VALID_NODE_ENVS as NodeEnv[];
export const VALID_NETWORKS: readonly NetworkType[] = constants.VALID_NETWORKS as NetworkType[];
export const VALID_DB_DRIVERS: readonly DbDriverType[] = constants.VALID_DB_DRIVERS as DbDriverType[];
