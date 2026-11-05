# Trust lines in Xaman (for people)

When the account an agent is paid at, or a person's own wallet, lives in the Xaman app, the person sets the trust line; an agent never holds that key. Each line locks one owner reserve (currently 0.2 XRP) while it exists.

Use only the issuers in the CAPPZ payment-asset registry:

| Token | Network | Currency | Issuer |
|---|---|---|---|
| RLUSD (`USD-tokenZ/1`) | mainnet | `RLUSD` (hex `524C555344000000000000000000000000000000`) | `rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De` |
| CAPPZ | mainnet | `CAPPZ` (hex `434150505A000000000000000000000000000000`) | `rMBcKBgMZFmVrSsJXubMUb2MpSxSLa6fTA` |

## RLUSD: on Xaman's list

1. In Xaman, tap **+ Add a token**, open **Stable**, choose RLUSD.
2. Tap **Setup TrustLine**. On the sign screen, check the issuer is `rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De`, then slide to sign.

## CAPPZ: not on Xaman's list

Xaman offers only its built-in list, so build the trust line elsewhere and sign it in Xaman:

1. Open XRPL Services (linked from Xaman's help center) and its **trust line** tool — not the page that lists the tokens an account issues. (Entering your own address there answers "This account does not issue any Token": your wallet does not issue tokens; the issuer field is the token's issuer.)
2. Enter the **issuer** `rMBcKBgMZFmVrSsJXubMUb2MpSxSLa6fTA`, the **currency** `CAPPZ` (or its hex), and a large **limit** (for example `1000000000`).
3. Choose to sign with Xaman and scan the QR code.
4. On Xaman's sign screen, check: a **TrustSet**, from **your** account, currency **CAPPZ**, issuer **`rMBcKBgMZFmVrSsJXubMUb2MpSxSLa6fTA`**. Then slide to sign. The sign screen is what protects you, whoever built the transaction.

## Check

`cappz-market check <your address> --currency CAPPZ` (or `--currency USD-tokenZ/1`) reports whether the line exists and has room. A line with a zero balance can be removed later (Xaman: the token's menu, or set the limit to 0).
