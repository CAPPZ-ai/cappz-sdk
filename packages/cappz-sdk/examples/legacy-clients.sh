#!/bin/sh
# CAPPZ edge node from the command line — nothing to install but curl and ldapsearch.
# NODE: where the node's legacy front end is (behind nginx/Caddy for TLS in production).
NODE=${NODE:-http://127.0.0.1:41447}

# Drop a file (any script, cron job or PHP client that can POST/PUT). The answer is a receipt:
# 201 released, 202 held for an operator, 422 rejected — with every check and its reason.
curl -sS -T statement.xml -H 'content-type: application/xml' "$NODE/legacy/v1/drop/statement.xml"

# Where does a file stand?
curl -sS "$NODE/legacy/v1/receipts/$(sha256sum statement.xml | cut -c1-64)"

# Internal clients: list released files and fetch one by hash (the DMZ never dials in).
curl -sS "$NODE/legacy/v1/released?format=text"
curl -sS -o statement.xml "$NODE/legacy/v1/objects/<sha256>"

# Senders that can only push FTP: implicit FTPS drop box (port 41449), uploads go to the same quarantine.
curl -sS -k -T batch.csv "ftps://bank-a:$BANK_A_FTP_PASS@dmz.example.com:41449/batch.csv"

# Directory lookups for LDAP clients (read-only, anonymous; port 41389 on the node's host).
ldapsearch -x -LLL -H ldap://127.0.0.1:41389 -b dc=cappz '(objectClass=cappzDevice)' cn displayName cappzEndpoint cappzTrust
