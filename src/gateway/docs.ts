/**
 * The interactive reference: one static page that loads Scalar from a pinned
 * jsDelivr version and reads this gateway's openapi.json. The page holds no
 * data; the document it reads is filtered to the calling credential.
 */

/** The Scalar release, pinned. Published 2026-10-12, so past the two-week rule. */
export const SCALAR_VERSION = "1.74.0";

/**
 * The docs page HTML.
 * @returns the document
 */
export function docsPage(): string {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Gateway API reference</title>
</head>
<body>
<script id="api-reference" data-url="/gateway/v1/openapi.json"></script>
<script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference@${SCALAR_VERSION}/dist/browser/standalone.js"></script>
</body>
</html>
`;
}
