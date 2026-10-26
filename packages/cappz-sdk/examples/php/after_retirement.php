<?php
/**
 * The PHP route after its signature check is retired. nginx asks the CAPPZ edge gateway first
 * (auth_request → /cappz/verify: signature, key declaration, revocation, replay, freshness); only verified
 * requests reach PHP, with Cappz-Verified-* headers. auth_request does not carry the body, so the one
 * check left here is that the body matches the Content-Digest the client signed.
 */
$body = file_get_contents('php://input');
if (!preg_match('/sha-256=:([A-Za-z0-9+\/=]+):/', $_SERVER['HTTP_CONTENT_DIGEST'] ?? '', $d) || !hash_equals(base64_decode($d[1]), hash('sha256', $body, true))) {
    http_response_code(422);
    header('Content-Type: application/json');
    echo json_encode(['error' => 'body does not match the signed Content-Digest']);
    exit;
}
header('Content-Type: application/json');
echo json_encode(['ok' => true, 'wallet' => $_SERVER['HTTP_CAPPZ_VERIFIED_WALLET'] ?? null, 'trust' => $_SERVER['HTTP_CAPPZ_VERIFIED_TRUST'] ?? null, 'bytes' => strlen($body)]);
