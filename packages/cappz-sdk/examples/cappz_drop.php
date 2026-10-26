<?php
/**
 * CAPPZ signed drop from PHP (7.2+, ext-sodium and ext-curl).
 *
 * Replaces PHP-side signature checks: the edge node verifies, your PHP code
 * only signs. Same RFC 9421 signature as sign_request.py.
 * NOTE: written to the same specification as the tested Python example; not
 * run in CAPPZ CI (no PHP runtime there). Report problems with the output.
 *
 *   php cappz_drop.php --new-key device.key            # once; prints the public key to declare in your wallet
 *   php cappz_drop.php device.key <wallet> http://127.0.0.1:41447/legacy/v1/drop/statement.xml statement.xml [declaration.json]
 */
const COMPONENTS = ['@method', '@path', '@authority', 'content-digest', 'cappz-wallet'];

function b64url(string $s): string { return rtrim(strtr(base64_encode($s), '+/', '-_'), '='); }

if (($argv[1] ?? '') === '--new-key') {
    $kp = sodium_crypto_sign_keypair();
    file_put_contents($argv[2], base64_encode(sodium_crypto_sign_secretkey($kp)));
    chmod($argv[2], 0600);
    echo bin2hex(sodium_crypto_sign_publickey($kp)), PHP_EOL;
    exit(0);
}
[$_, $keyFile, $wallet, $url, $file] = $argv + [null, null, null, null, null];
$declFile = $argv[5] ?? null;
$secret = base64_decode(trim(file_get_contents($keyFile)));
$public = bin2hex(sodium_crypto_sign_publickey_from_secretkey($secret));
$body = file_get_contents($file);
$u = parse_url($url);
$authority = strtolower($u['host'] . (isset($u['port']) ? ':' . $u['port'] : ''));
$digest = 'sha-256=:' . base64_encode(hash('sha256', $body, true)) . ':';
$params = '(' . implode(' ', array_map(fn($c) => "\"$c\"", COMPONENTS)) . ');created=' . time() . ";keyid=\"$public\";alg=\"ed25519\";nonce=\"" . bin2hex(random_bytes(12)) . '"';
$values = ['@method' => 'PUT', '@path' => $u['path'] ?? '/', '@authority' => $authority, 'content-digest' => $digest, 'cappz-wallet' => $wallet];
$base = implode("\n", array_map(fn($c) => "\"$c\": {$values[$c]}", COMPONENTS)) . "\n\"@signature-params\": $params";
$sig = base64_encode(sodium_crypto_sign_detached($base, $secret));
$headers = ["content-digest: $digest", "cappz-wallet: $wallet", "signature-input: sig1=$params", "signature: sig1=:$sig:", 'content-type: application/octet-stream'];
if ($declFile) $headers[] = 'cappz-key-declaration: ' . b64url(file_get_contents($declFile));
$ch = curl_init($url);
curl_setopt_array($ch, [CURLOPT_CUSTOMREQUEST => 'PUT', CURLOPT_POSTFIELDS => $body, CURLOPT_HTTPHEADER => $headers, CURLOPT_RETURNTRANSFER => true]);
$out = curl_exec($ch);
echo curl_getinfo($ch, CURLINFO_RESPONSE_CODE), ' ', $out, PHP_EOL;
