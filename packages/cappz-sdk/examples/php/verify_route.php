<?php
/**
 * A PHP route that verifies requests itself — the "legacy verifier" the CAPPZ
 * edge gateway shadows before it is retired (src/lib/identity/shadowCompare.ts).
 *
 * It checks what a typical PHP integration checks: an RFC 9421 Ed25519
 * signature (sodium) over @method, @path, @authority, content-digest and
 * cappz-wallet, the RFC 9530 Content-Digest against the body, a ±300 s
 * freshness window, and a key allow-list file ({ "<wallet>": ["<hex key>", …] }).
 * It keeps no replay memory and knows nothing about revocations made after the
 * file was written — the two places the edge gateway is stricter.
 *
 * For the comparison it reports its own verdict and verify time:
 *   X-Legacy-Verdict: allow | deny
 *   Server-Timing: verify;dur=<ms>
 *
 * nginx + php-fpm:   location /api/ { include fastcgi_params; fastcgi_param SCRIPT_FILENAME /path/verify_route.php; fastcgi_pass unix:/run/php/php8.4-fpm.sock; }
 * quick test:        CAPPZ_PHP_KEYS=keys.json php -S 127.0.0.1:8081 verify_route.php
 */
const COMPONENTS = ['@method', '@path', '@authority', 'content-digest', 'cappz-wallet'];

function deny(string $why, float $t0): never {
    header('X-Legacy-Verdict: deny');
    header('Server-Timing: verify;dur=' . round((hrtime(true) - $t0) / 1e6, 3));
    http_response_code(401);
    header('Content-Type: application/json');
    echo json_encode(['verdict' => 'deny', 'because' => $why]);
    exit;
}

$t0 = hrtime(true);
$h = fn(string $n) => $_SERVER['HTTP_' . strtoupper(str_replace('-', '_', $n))] ?? null;
$body = file_get_contents('php://input');
$input = $h('signature-input'); $sigHeader = $h('signature'); $wallet = $h('cappz-wallet'); $digest = $h('content-digest');
if (!$input || !$sigHeader || !$wallet || !$digest) deny('unsigned', $t0);
if (!preg_match('/^sig1=\(([^)]*)\)(.*)$/', trim($input), $m)) deny('malformed signature-input', $t0);
preg_match_all('/"([^"]+)"/', $m[1], $c);
if ($c[1] !== COMPONENTS) deny('signature must cover ' . implode(' ', COMPONENTS), $t0);
preg_match_all('/;(\w+)=("([^"]*)"|\d+)/', $m[2], $p, PREG_SET_ORDER);
// Quoted values land in group 3; bare numbers (created=…) leave it out entirely.
$params = []; foreach ($p as $x) $params[$x[1]] = isset($x[3]) && $x[3] !== '' ? $x[3] : $x[2];
if (($params['alg'] ?? '') !== 'ed25519' || empty($params['keyid'])) deny('alg must be ed25519 with a keyid', $t0);
if (abs(time() - (int)($params['created'] ?? 0)) > 300) deny('stale', $t0);
if (!preg_match('/sha-256=:([A-Za-z0-9+\/=]+):/', $digest, $d) || !hash_equals(base64_decode($d[1]), hash('sha256', $body, true))) deny('digest-mismatch', $t0);
// X-Original-Host is the host the client signed for; honour it only from the local gateway (it replaces Host).
$fromGateway = in_array($_SERVER['REMOTE_ADDR'] ?? '', ['127.0.0.1', '::1'], true);
$authority = strtolower(($fromGateway ? ($_SERVER['HTTP_X_ORIGINAL_HOST'] ?? null) : null) ?? $_SERVER['HTTP_HOST'] ?? '');
$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
$values = ['@method' => strtoupper($_SERVER['REQUEST_METHOD']), '@path' => $path, '@authority' => $authority, 'content-digest' => $digest, 'cappz-wallet' => $wallet];
$base = implode("\n", array_map(fn($k) => "\"$k\": {$values[$k]}", COMPONENTS)) . "\n\"@signature-params\": " . substr(trim($input), 5);
if (!preg_match('/sig1=:([A-Za-z0-9+\/=]+):/', $sigHeader, $s)) deny('malformed signature', $t0);
$sig = base64_decode($s[1]); $pub = @hex2bin($params['keyid']);
if ($pub === false || strlen($pub) !== 32 || strlen($sig) !== 64 || !sodium_crypto_sign_verify_detached($sig, $base, $pub)) deny('bad-signature', $t0);
static $keys = null;
$keys ??= json_decode(@file_get_contents(getenv('CAPPZ_PHP_KEYS') ?: __DIR__ . '/keys.json') ?: '{}', true) ?: [];
if (!in_array(strtolower($params['keyid']), array_map('strtolower', $keys[$wallet] ?? []), true)) deny('unknown key', $t0);

header('X-Legacy-Verdict: allow');
header('Server-Timing: verify;dur=' . round((hrtime(true) - $t0) / 1e6, 3));
header('Content-Type: application/json');
echo json_encode(['verdict' => 'allow', 'wallet' => $wallet, 'bytes' => strlen($body)]);
