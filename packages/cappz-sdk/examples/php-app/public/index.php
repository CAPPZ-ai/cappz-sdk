<?php
// The HTML page stays on PHP in the example: it uses a session and a CSRF token (wave 3).
session_start();
$_SESSION['csrf'] ??= bin2hex(random_bytes(16));
require_once __DIR__ . '/../lib/orders.php';
$open = array_filter(load_orders(), fn ($o) => $o['status'] === 'open');
?><!doctype html>
<html><head><title>Orders</title></head><body>
<h1>Open orders (<?= count($open) ?>)</h1>
<form method="post" action="/api/orders.php"><input type="hidden" name="csrf" value="<?= $_SESSION['csrf'] ?>"><input name="customer"><input name="amount"><button>Add</button></form>
<ul><?php foreach ($open as $o): ?><li><?= htmlspecialchars($o['id']) ?> · <?= htmlspecialchars($o['customer']) ?> · <?= $o['amount'] ?></li><?php endforeach; ?></ul>
</body></html>
