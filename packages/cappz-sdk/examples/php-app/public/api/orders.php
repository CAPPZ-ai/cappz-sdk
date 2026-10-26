<?php
// GET  /api/orders.php            list (optional ?status=open|shipped|cancelled)
// GET  /api/orders.php?id=o-0001  one order
// POST /api/orders.php            create { customer, amount }
require_once __DIR__ . '/../../lib/orders.php';
header('Content-Type: application/json');

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $in = json_decode(file_get_contents('php://input'), true);
    if (!is_array($in) || !is_string($in['customer'] ?? null) || !is_numeric($in['amount'] ?? null) || $in['amount'] <= 0) {
        http_response_code(422);
        echo json_encode(['error' => 'customer (string) and amount (> 0) are required']);
        exit;
    }
    $orders = load_orders();
    $order = ['id' => sprintf('o-%04d', count($orders) + 1), 'customer' => $in['customer'], 'amount' => round((float) $in['amount'], 2), 'status' => 'open', 'items' => []];
    $orders[] = $order;
    save_orders($orders);
    http_response_code(201);
    echo json_encode(['order' => $order]);
    exit;
}

$orders = load_orders();
if (isset($_GET['id'])) {
    foreach ($orders as $o) {
        if ($o['id'] === $_GET['id']) { echo json_encode(['order' => $o, 'generatedAt' => gmdate('c')]); exit; }
    }
    http_response_code(404);
    echo json_encode(['error' => 'no such order']);
    exit;
}
$status = $_GET['status'] ?? null;
$list = array_values(array_filter($orders, fn ($o) => $status === null || $o['status'] === $status));
echo json_encode(['orders' => $list, 'count' => count($list), 'total' => round(array_sum(array_column($list, 'amount')), 2), 'generatedAt' => gmdate('c')]);
