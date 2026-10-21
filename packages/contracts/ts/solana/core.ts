import {
  MPL_CORE_PROGRAM_ID,
  createV1,
  deserializeAssetV1,
  getMplCoreErrorFromCode,
  transferV1,
} from '@metaplex-foundation/mpl-core'
import {
  createNoopSigner,
  publicKey,
  type Context,
  type Instruction as UmiInstruction,
  type Program,
  type RpcAccount,
} from '@metaplex-foundation/umi'
import {
  AccountRole,
  address,
  getBase58Decoder,
  getBase64Encoder,
  type Address,
  type Instruction,
  type Rpc,
  type SolanaRpcApi,
} from '@solana/kit'

export const MPL_CORE_PROGRAM_ADDRESS = address(MPL_CORE_PROGRAM_ID)

/**
 * `mpl-core` ships Umi builders only. Umi is used here purely as an instruction encoder: the generated
 * code reads `payer` and `programs.getPublicKey()` from its context, nothing else. The instructions
 * are converted to `@solana/kit` ones, so the app runs a single Solana stack (kit) for RPC and signing.
 */
function context(payer: Address): Pick<Context, 'payer' | 'programs'> {
  return {
    payer: createNoopSigner(publicKey(payer)),
    programs: { getPublicKey: (_name: string, fallback?: string) => publicKey(fallback!) } as unknown as Context['programs'],
  }
}

function toKit(ix: UmiInstruction): Instruction {
  return {
    programAddress: address(ix.programId),
    accounts: ix.keys.map((key) => ({
      address: address(key.pubkey),
      role: key.isSigner
        ? key.isWritable
          ? AccountRole.WRITABLE_SIGNER
          : AccountRole.READONLY_SIGNER
        : key.isWritable
          ? AccountRole.WRITABLE
          : AccountRole.READONLY,
    })),
    data: new Uint8Array(ix.data),
  }
}

/** CreateV1: a new asset account, signed by the asset keypair and the payer. */
export function createAssetInstruction(params: {
  payer: Address
  owner: Address
  asset: Address
  name: string
  uri: string
}): Instruction {
  const builder = createV1(context(params.payer), {
    asset: createNoopSigner(publicKey(params.asset)),
    owner: publicKey(params.owner),
    name: params.name,
    uri: params.uri,
  })
  return toKit(builder.getInstructions()[0]!)
}

export function transferAssetInstruction(params: { payer: Address; asset: Address; newOwner: Address }): Instruction {
  const builder = transferV1(context(params.payer), {
    asset: publicKey(params.asset),
    newOwner: publicKey(params.newOwner),
  })
  return toKit(builder.getInstructions()[0]!)
}

export interface CoreAsset {
  readonly address: Address
  readonly owner: Address
  readonly name: string
  readonly uri: string
}

const ASSET_V1_KEY = getBase58Decoder().decode(new Uint8Array([1])) // Key::AssetV1 discriminator

/**
 * Assets owned by `owner`, straight from the program (works on any validator, unlike the DAS API
 * which needs an indexer). AssetV1 layout: key (1 byte) ‖ owner (32 bytes) ‖ …
 */
export async function fetchAssetsByOwner(rpc: Rpc<SolanaRpcApi>, owner: Address): Promise<CoreAsset[]> {
  const accounts = await rpc
    .getProgramAccounts(MPL_CORE_PROGRAM_ADDRESS, {
      encoding: 'base64',
      filters: [
        { memcmp: { offset: 0n, bytes: ASSET_V1_KEY as never, encoding: 'base58' } },
        { memcmp: { offset: 1n, bytes: owner as never, encoding: 'base58' } },
      ],
    })
    .send()
  return accounts.flatMap(({ pubkey, account }) => {
    try {
      const data = new Uint8Array(getBase64Encoder().encode(account.data[0]))
      // Only `publicKey` and `data` are read by the deserializer.
      const asset = deserializeAssetV1({ publicKey: publicKey(pubkey), data } as unknown as RpcAccount)
      return [{ address: pubkey, owner: address(asset.owner), name: asset.name.slice(0, 200), uri: asset.uri }]
    } catch {
      return [] // not an asset we can read; skip rather than break the list
    }
  })
}

const PROGRAM = { name: 'mplCore', publicKey: publicKey(MPL_CORE_PROGRAM_ID) } as unknown as Program

/** Program error code → name (e.g. `InvalidAuthority`), for the Solana tx engine's `programErrors`. */
export function coreErrorName(programAddress: string, code: number): string | undefined {
  if (programAddress !== MPL_CORE_PROGRAM_ID) return undefined
  return getMplCoreErrorFromCode(code, PROGRAM)?.name
}
