// @ts-check
import * as dagCbor from '@ipld/dag-cbor'
import * as dagPb from '@ipld/dag-pb'
import { UnixFS } from 'ipfs-unixfs'
import { type CID } from 'multiformats/cid'
import { toCidOrNull, getCodeOrNull, toCidStrOrNull } from './cid.js'
import { isTruthy } from './helpers.js'
import type { NormalizedDagPbNodeFormat, CodecType, NormalizedDagNode, NormalizedDagLink, dagNode } from '../types.js'
import type { PBLink, PBNode } from '@ipld/dag-pb'

function isDagPbNode (node: dagNode | PBNode, cid: string): node is PBNode {
  const code = getCodeOrNull(cid)
  return code === dagPb.code
}

/**
 * Provide a uniform shape for all^ node types.
 *
 * Spare the rest of the codebase from having to cope with all possible node
 * shapes.
 *
 * ^: currently dag-cbor and dag-pb are supported.
 *
 * @function normaliseDagNode
 * @param {dagNode|import('@ipld/dag-pb').PBNode} node - the `value` prop from `ipfs.dag.get` response.
 * @param {string} cidStr - the cid string passed to `ipfs.dag.get`
 * @returns {import('../types').NormalizedDagNode}
 */
export function normaliseDagNode (node: dagNode | PBNode, cidStr: string): NormalizedDagNode {
  const code = getCodeOrNull(cidStr)
  if (isDagPbNode(node, cidStr)) {
    return normaliseDagPb(node, cidStr, dagPb.code)
  }
  // try cbor style if we don't know any better
  // @ts-expect-error - todo: resolve node type error
  return normaliseDagCbor(node, cidStr, code ?? dagCbor.code)
}
export default normaliseDagNode

/**
 * Normalize links and add type info. Add unixfs info where available
 */
export function normaliseDagPb (node: PBNode, cid: string, type: CodecType): NormalizedDagNode {
  // NOTE: Use the requested cid rather than the internal one.
  // The multihash property on a DAGNode is always cidv0, regardless of request cid.
  // SEE: https://github.com/ipld/js-ipld-dag-pb/issues/84

  // if (toCidStrOrNull(node.multihash) !== cid) {
  //   throw new Error('dag-pb multihash should match provided cid')
  // }

  const cidStr = toCidStrOrNull(cid)
  if (cidStr == null) {
    throw new Error(`cidStr is null for cid: ${cid}`)
  }

  let format: NormalizedDagPbNodeFormat = 'non-unixfs'
  const data = node.Data

  if (data != null) {
    try {
    // it's a unix system?
      const unixFsObj = UnixFS.unmarshal(data)
      const { type, data: unixFsData, blockSizes } = unixFsObj
      format = 'unixfs'

      return {
        cid: cidStr,
        type,
        // @ts-expect-error - type is a string and not assignable to `UnixFsNodeTypes`
        data: { type, data: unixFsData, blockSizes },
        links: normaliseDagPbLinks(node.Links, cid),
        size: unixFsObj.fileSize(),
        format
      }
    } catch (err) {
      // dag-pb but not a unixfs.
    }
  }

  return {
    cid: cidStr,
    type,
    data,
    links: normaliseDagPbLinks(node.Links, cid),
    format
  }
}

/**
 * Convert DagLink shape into normalized form that can be used interchangeably
 * with links found in dag-cbor
 */
export function normaliseDagPbLinks (links: PBLink[], sourceCid: string): NormalizedDagLink[] {
  return links.map((link, index) => ({
    path: isTruthy(link.Name) ? link.Name : `Links/${index}`,
    source: sourceCid,
    target: toCidStrOrNull(link.Hash) ?? '',
    size: BigInt(link.Tsize ?? 0),
    index
  }))
}

/**
 * Find links and add type and cid info
 *
 * @function normaliseDagCbor
 * @param {import('../types').NormalizedDagNode['data']} data - The data object
 * @param {string} cid - The string representation of the CID
 * @param {number} code - multicodec code, see https://github.com/multiformats/multicodec/blob/master/table.csv
 * @returns {import('../types').NormalizedDagNode}
 */
export function normaliseDagCbor (data: NormalizedDagNode['data'], cid: string, code: number): NormalizedDagNode {
  const links = findAndReplaceDagCborLinks(data, cid)
  return {
    cid,
    type: code,
    data,
    links,
    size: links.reduce((acc, { size }) => acc + size, BigInt(0)),
    format: 'unknown'
  }
}

type PlainObjectOrArray = Record<string, unknown> | unknown[] | string

function isPlainObjectOrArray (obj: unknown): obj is PlainObjectOrArray {
  return (
    obj !== null &&
    typeof obj === 'object' &&
    !(obj instanceof ArrayBuffer) &&
    !ArrayBuffer.isView(obj) &&
    !(typeof obj === 'string')
  )
}

type DagCborNodeObject = Record<string, unknown> & { '/': string | CID | null }

/**
 * This should be called after `isPlainObjectOrArray` to avoid type errors.
 */
function isDagCborNodeObject (obj: PlainObjectOrArray): obj is DagCborNodeObject {
  return Object.keys(obj).length === 1 && (obj as Record<string, unknown>)['/'] != null
}

/**
 * A valid IPLD link in a dag-cbor node is an object with single "/" property.
 */
export function findAndReplaceDagCborLinks (obj: unknown, sourceCid: string, path: string = ''): NormalizedDagLink[] {
  if (!isPlainObjectOrArray(obj)) {
    return []
  }

  const cid = toCidOrNull(obj)
  if (typeof obj === 'string' || cid != null) {
    if (cid != null) {
      return [{ path, source: sourceCid, target: cid.toString(), size: BigInt(0), index: 0 }]
    }
    return []
  }

  if (Array.isArray(obj)) {
    if (obj.length === 0) return []

    return obj
      .map((val, i) => findAndReplaceDagCborLinks(val, sourceCid, path != null ? `${path}/${i}` : `${i}`))
      .reduce((a, b) => a.concat(b))
      .filter(a => Boolean(a))
  }

  const keys = Object.keys(obj)

  // Support older `{ "/": Buffer } style links until all the IPLD formats are updated.
  if (isDagCborNodeObject(obj)) {
    const targetCid = toCidOrNull(obj['/'])

    if (targetCid == null) return []

    const target = targetCid.toString()
    obj['/'] = target

    return [{ path, source: sourceCid, target, size: BigInt(0), index: 0 }]
  }

  if (keys.length > 0) {
    return keys
      .map(key => findAndReplaceDagCborLinks(obj[key], sourceCid, isTruthy(path) ? `${path}/${key}` : `${key}`))
      .reduce((a, b) => a.concat(b))
      .filter(a => Boolean(a))
  } else {
    return []
  }
}
