#!/bin/sh
# Runs ani-cli's own scraping functions non-interactively.
# Everything before the argument parser in the upstream script (functions + setup)
# is loaded as-is, so `git pull` in the repo keeps this working when the site changes.
#
# usage: bridge.sh search <query>
#        bridge.sh episodes <anime_id>
#        bridge.sh links <anime_id> <ep_no> <sub|dub>
#        bridge.sh version

script="${ANI_CLI_SCRIPT:-$(dirname "$0")/../ani-cli}"
[ -f "$script" ] || { printf "ani-cli script not found at %s\n" "$script" >&2; exit 1; }

ANI_CLI_PLAYER=debug
ANI_CLI_MENU=true
export ANI_CLI_PLAYER ANI_CLI_MENU

eval "$(sed -n '1,/^while \[ \$# -gt 0 \]/p' "$script" | sed '$d')"

cmd="$1"
shift
case "$cmd" in
    version) printf "%s\n" "$version_number" ;;
    search)
        # fetch once, let upstream parse ids/titles ("r" lines), then pull posters/counts from the same page ("m" lines)
        query="$(printf "%s" "$*" | sed 's| |+|g')"
        # shellcheck disable=SC2059
        _cached_page="$(hianime_curl "$(printf "$search_api" "$query")")" || exit 1
        hianime_curl() { printf "%s" "$_cached_page"; }
        { hianime_search "$query"; echo; } | sed "/^$/d; s|^|r\t|"
        printf "%s" "$_cached_page" | sed '/id="main-sidebar"/,$d' | tr '\n' ' ' | sed 's|<div class="flw-item|\n&|g' |
            while read -r _item || [ -n "$_item" ]; do
                _id="$(printf "%s" "$_item" | sed -nE 's|.*<h3 class="film-name">[[:space:]]*<a href="[^"]*/([^"/]*)".*|\1|p')"
                [ -z "$_id" ] && continue
                _poster="$(printf "%s" "$_item" | sed -nE 's|.*<img src="([^"]*)".*|\1|p')"
                _sub="$(printf "%s" "$_item" | sed -nE 's|.*tick-sub">(<[^>]*>)*([0-9]+)<.*|\2|p')"
                _dub="$(printf "%s" "$_item" | sed -nE 's|.*tick-dub">(<[^>]*>)*([0-9]+)<.*|\2|p')"
                _type="$(printf "%s" "$_item" | sed -nE 's|.*<span class="fdi-item">([^<]*)</span>.*|\1|p')"
                printf "m\t%s\t%s\t%s\t%s\t%s\n" "$_id" "$_poster" "$_sub" "$_dub" "$_type"
            done
        ;;
    episodes) hianime_episodes "$1" ;;
    links)
        anime_id="$1" ep_no="$2" mode="${3:-sub}"
        episode_maps="$(hianime_episodes "$anime_id")" || exit 1
        hianime_m3u8 "$ep_no" "$mode" || die "No sources found for $mode!"
        printf "master\t%s\n" "$_m3u8_master"
        printf "refr\t%s\n" "$refr"
        printf "mal_id\t%s\n" "$mal_id"
        printf "sub\t%s\n" "$sub_link"
        printf "audio\t%s\n" "$audio_link"
        printf "%s\n" "$links" | sed -nE 's|^([^ ]*) ?>(.*)$|link\t\1\t\2|p'
        ;;
    *) die "unknown command: $cmd" ;;
esac
