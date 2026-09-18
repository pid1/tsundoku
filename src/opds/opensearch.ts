import { CT } from "../http/responses.js";
import { escapeXml } from "../util.js";

/**
 * OpenSearch description document. OPDS 1.2 discovers search through this: the
 * Url template must declare the acquisition-feed media type, or readers will
 * not treat the results as a catalog.
 */
export function openSearchDescription(origin: string, catalogTitle: string): string {
  const e = escapeXml;
  return `<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/">
  <ShortName>${e(catalogTitle)}</ShortName>
  <Description>Search ${e(catalogTitle)} by title, author, series or subject.</Description>
  <InputEncoding>UTF-8</InputEncoding>
  <OutputEncoding>UTF-8</OutputEncoding>
  <Url type="${e(CT.opdsAcq)}"
       template="${e(origin)}/opds/1.2/search?q={searchTerms}&amp;page={startPage?}"/>
  <Url type="${e(CT.opdsJson)}"
       template="${e(origin)}/opds/2.0/search?query={searchTerms}&amp;page={startPage?}"/>
  <Query role="example" searchTerms="le guin"/>
</OpenSearchDescription>`;
}
