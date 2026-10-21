/**
 * Solana transaction codecs. With their dependencies (transaction messages, data-structure codecs) they
 * are the bulk of @solana/kit that the connectors use, and only signing needs them: they load with the
 * first Solana transaction, not with the wallet list.
 */
export { getTransactionDecoder, getTransactionEncoder } from '@solana/kit'
