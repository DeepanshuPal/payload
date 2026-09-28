import type { SanitizedCollectionConfig, SanitizedJoin } from '../collections/config/types.js'
import type { JoinQuery, PayloadRequest, Where } from '../types/index.js'

import { executeAccess } from '../auth/executeAccess.js'
import { QueryError } from '../errors/QueryError.js'
import { combineQueries } from './combineQueries.js'
import { validateQueryPaths } from './queryValidation/validateQueryPaths.js'
import { validateSortQuery } from './queryValidation/validateSortQuery.js'
import { sanitizeWhereQuery } from './sanitizeWhereQuery.js'

type Args = {
  collectionConfig: SanitizedCollectionConfig
  joins?: JoinQuery
  overrideAccess: boolean
  req: PayloadRequest
}

const sanitizeJoinFieldQuery = async ({
  collectionSlug,
  errors,
  join,
  joinsQuery,
  overrideAccess,
  polymorphic,
  validationWhereByJoin,
  promises,
  req,
}: {
  collectionSlug: string
  errors: { path: string }[]
  join: SanitizedJoin
  joinsQuery: JoinQuery
  overrideAccess: boolean
  polymorphic: boolean
  validationWhereByJoin: Map<string, Where>
  promises: Promise<void>[]
  req: PayloadRequest
}) => {
  const { joinPath } = join

  // TODO: fix any's in joinsQuery[joinPath]

  if ((joinsQuery as any)[joinPath] === false) {
    return
  }

  const joinCollectionConfig = req.payload.collections[collectionSlug]!.config

  const accessResult = !overrideAccess
    ? await executeAccess(
        { slug: joinCollectionConfig.slug, disableErrors: true, req },
        joinCollectionConfig.access.read,
      )
    : true

  if (accessResult === false && !polymorphic) {
    ;(joinsQuery as any)[joinPath] = false
    return
  }

  if (!(joinsQuery as any)[joinPath]) {
    ;(joinsQuery as any)[joinPath] = {}
  }

  const joinQuery = (joinsQuery as any)[joinPath]

  if (!joinQuery.where) {
    joinQuery.where = {}
  }

  if (join.field.where) {
    joinQuery.where = combineQueries(joinQuery.where, join.field.where)
  }

  // Validate only caller and field constraints, not access constraints added for earlier targets.
  if (polymorphic && !validationWhereByJoin.has(joinPath)) {
    validationWhereByJoin.set(joinPath, joinQuery.where)
  }

  promises.push(
    validateQueryPaths({
      collectionConfig: joinCollectionConfig,
      errors,
      overrideAccess,
      polymorphicJoin: Array.isArray(join.field.collection),
      req,
      // incoming where input, but we shouldn't validate generated from the access control.
      where: polymorphic ? validationWhereByJoin.get(joinPath)! : joinQuery.where,
    }),
    validateSortQuery({
      collectionConfig: joinCollectionConfig,
      overrideAccess,
      req,
      sort: joinQuery.sort || join.field.defaultSort || joinCollectionConfig.defaultSort,
    }),
  )

  if (accessResult === false) {
    // A denied polymorphic target must not suppress permitted targets.
    joinQuery.where = combineQueries(joinQuery.where, {
      relationTo: { not_equals: collectionSlug },
    })
    return
  }

  if (typeof accessResult === 'object') {
    sanitizeWhereQuery({
      fields: joinCollectionConfig.flattenedFields,
      payload: req.payload,
      where: accessResult,
    })
    joinQuery.where = combineQueries(
      joinQuery.where,
      polymorphic
        ? { or: [{ relationTo: { not_equals: collectionSlug } }, accessResult] }
        : accessResult,
    )
  }
}

/**
 * * Validates `where` for each join
 * * Combines the access result for joined collection
 * * Combines the default join's `where`
 */
export const sanitizeJoinQuery = async ({
  collectionConfig,
  joins: joinsQuery,
  overrideAccess,
  req,
}: Args) => {
  if (joinsQuery === false) {
    return false
  }

  if (!joinsQuery) {
    joinsQuery = {}
  }

  const errors: { path: string }[] = []
  const promises: Promise<void>[] = []
  const validationWhereByJoin = new Map<string, Where>()

  for (const collectionSlug in collectionConfig.joins) {
    for (const join of collectionConfig.joins[collectionSlug]!) {
      await sanitizeJoinFieldQuery({
        collectionSlug,
        errors,
        join,
        joinsQuery,
        overrideAccess,
        polymorphic: false,
        validationWhereByJoin,
        promises,
        req,
      })
    }
  }

  for (const join of collectionConfig.polymorphicJoins) {
    for (const collectionSlug of join.field.collection) {
      await sanitizeJoinFieldQuery({
        collectionSlug,
        errors,
        join,
        joinsQuery,
        overrideAccess,
        polymorphic: true,
        validationWhereByJoin,
        promises,
        req,
      })
    }
  }

  await Promise.all(promises)

  if (errors.length > 0) {
    throw new QueryError(errors)
  }

  return joinsQuery
}
