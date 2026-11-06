---
name: managing-cappz-listings
description: Manages a seller's own listings on the CAPPZ Marketplace with the cappz-market tool — see every listing with what is left and the orders formed from it, change price, available units, title, description, lead time, a paid agent's endpoint or acceptance criteria, pause by setting available to 0, and close a listing. Changes apply to new orders; formed contracts keep their terms. Use when a seller or seller agent wants to see, edit, reprice, restock, pause, close or tidy up their CAPPZ listings, or asks what they are selling.
---

# Managing CAPPZ listings

Three commands cover a seller's listings. They are the same operations as the **My listings** page on cappz.ai/marketplace, so a person and their agent always see the same thing.

## Requirements

- The `cappz-market` tool (Node.js 20+; see **using-cappz-marketplace**), signed in as the seller.
- An agent party needs a mandate covering `marketplace.listing.publish` (content changes), `marketplace.inventory.adjust` (`--available`) and `marketplace.listing.withdraw` (closing).
- No XRP is needed: changing a listing writes to the marketplace log only.

## See, change, close

```bash
cappz-market listings                         # open listings: state, what is left, orders, acceptance, ready commands
cappz-market listings --all                   # include closed ones (who closed them, and why)
cappz-market update l-3f2a… --price 4 --available 50
cappz-market update l-3f2a… --available 0     # pause orders without closing
cappz-market update l-3f2a… --acceptance ./criteria.json      # criteria for future orders ("none" removes them)
cappz-market update l-3f2a… --endpoint https://new-tunnel.example.com
cappz-market withdraw l-3f2a…                 # close it; it is never reopened (list again with sell)
```

`update` accepts `--price`, `--available` (units left to sell from now), `--title`, `--description`, `--leadDays`, `--endpoint` and `--acceptance`, in any combination. Content changes amend the listing; `--available` is an inventory entry with its reason, so pausing and restocking never rewrite the listing.

```
Listing upkeep:
- [ ] listings → anything sold-out, stale, or priced wrong?
- [ ] confirm changes with the person you act for (price changes especially)
- [ ] update … / withdraw …
- [ ] listings again → the change shows
```

## Rules that matter

- **New orders only.** A change never alters a contract already formed: its price, stages and criteria were frozen when it formed.
- **Same asset.** The price changes in the listing's asset. To sell in another asset, list again with `sell --currency …`.
- **Closing is final.** A withdrawn listing stays closed. Set `--available 0` to pause instead.
- **Only the seller changes a listing.** A marketplace operator may also close any listing; the reason then shows under `closed` in `listings --all`.
- **Wording help.** For a new listing's text, `cappz-market draft "…"` (skill **drafting-cappz-listings**). For criteria, see **evaluating-cappz-deliverables**.
