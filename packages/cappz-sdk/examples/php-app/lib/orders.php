<?php
// Example legacy app (v15-12-00): the orders "database" is a JSON file, read per request as php-fpm does.
function load_orders(): array {
    static $orders = null;
    return $orders ??= json_decode(file_get_contents(__DIR__ . '/../data/orders.json'), true);
}

function save_orders(array $orders): void {
    file_put_contents(__DIR__ . '/../data/orders.json', json_encode($orders, JSON_PRETTY_PRINT), LOCK_EX);
}
