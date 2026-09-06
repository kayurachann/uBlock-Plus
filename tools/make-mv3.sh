#!/usr/bin/env bash
#
# This script assumes a linux environment

set -e
shopt -s extglob

echo "*** uBlock Plus+ MV3: Creating extension"

PLATFORM="chromium"

for i in "$@"; do
  case $i in
    full)
      FULL="yes"
      ;;
    firefox)
      PLATFORM="firefox"
      ;;
    chromium)
      PLATFORM="chromium"
      ;;
    edge)
      PLATFORM="edge"
      ;;
    safari)
      PLATFORM="safari"
      ;;
    +([0-9]).+([0-9]).+([0-9]))
      TAGNAME="$i"
      FULL="yes"
      ;;
    before=+([[:print:]]))
      BEFORE="${i:7}"
      ;;
  esac
done

echo "PLATFORM=$PLATFORM"
echo "TAGNAME=$TAGNAME"
echo "BEFORE=$BEFORE"

OUTPUT_DIR="dist/build/uBlockPlus.$PLATFORM"

if [ "$PLATFORM" = "edge" ]; then
    MANIFEST_DIR="chromium"
else
    MANIFEST_DIR="$PLATFORM"
fi

rm -rf $OUTPUT_DIR

mkdir -p $OUTPUT_DIR
cd $OUTPUT_DIR
OUTPUT_DIR=$(pwd)
cd - > /dev/null

mkdir -p "$OUTPUT_DIR"/css/fonts
mkdir -p "$OUTPUT_DIR"/js/offscreen
mkdir -p "$OUTPUT_DIR"/img
mkdir -p "$OUTPUT_DIR"/lib

if [ -n "$UBO_VERSION" ]; then
    UBO_REPO="https://github.com/gorhill/uBlock.git"
    UBO_DIR=$(mktemp -d)
    echo "*** uBlock Plus+ MV3: Fetching uBO $UBO_VERSION from $UBO_REPO into $UBO_DIR"
    cd "$UBO_DIR"
    git init -q
    git remote add origin "https://github.com/gorhill/uBlock.git"
    git fetch --depth 1 origin "$UBO_VERSION"
    git checkout -q FETCH_HEAD
    cd - > /dev/null
else
    UBO_DIR=.
fi

echo "*** uBlock Plus+ MV3: Copying common files"
cp -R "$UBO_DIR"/src/css/fonts/Inter "$OUTPUT_DIR"/css/fonts/
cp "$UBO_DIR"/src/css/themes/default.css "$OUTPUT_DIR"/css/
cp "$UBO_DIR"/src/css/common.css "$OUTPUT_DIR"/css/
cp "$UBO_DIR"/src/css/dashboard-common.css "$OUTPUT_DIR"/css/
cp "$UBO_DIR"/src/css/fa-icons.css "$OUTPUT_DIR"/css/

cp "$UBO_DIR"/src/js/arglist-parser.js "$OUTPUT_DIR"/js/
cp "$UBO_DIR"/src/js/dom.js "$OUTPUT_DIR"/js/
cp "$UBO_DIR"/src/js/fa-icons.js "$OUTPUT_DIR"/js/
cp "$UBO_DIR"/src/js/i18n.js "$OUTPUT_DIR"/js/
cp "$UBO_DIR"/src/js/jsonpath.js "$OUTPUT_DIR"/js/
cp "$UBO_DIR"/src/js/redirect-resources.js "$OUTPUT_DIR"/js/
cp "$UBO_DIR"/src/js/regex-analyzer.js "$OUTPUT_DIR"/js/offscreen/
cp -R "$UBO_DIR"/src/js/resources "$OUTPUT_DIR"/js/
cp "$UBO_DIR"/src/js/static-filtering-parser.js "$OUTPUT_DIR"/js/
cp "$UBO_DIR"/src/js/urlskip.js "$OUTPUT_DIR"/js/
cp "$UBO_DIR"/src/lib/punycode.js "$OUTPUT_DIR"/js/
cp -R "$UBO_DIR"/src/lib/regexanalyzer "$OUTPUT_DIR"/lib/

cp -R "$UBO_DIR/src/img/flags-of-the-world" "$OUTPUT_DIR"/img

cp LICENSE.txt "$OUTPUT_DIR"/
cp NOTICE.md "$OUTPUT_DIR"/

echo "*** uBlock Plus+ MV3: Copying MV3-specific files"
cp platform/mv3/"$MANIFEST_DIR"/manifest.json "$OUTPUT_DIR"/
cp platform/mv3/extension/*.html "$OUTPUT_DIR"/
cp platform/mv3/extension/*.json "$OUTPUT_DIR"/
cp -R platform/mv3/extension/filter-store "$OUTPUT_DIR"/
cp platform/mv3/extension/css/* "$OUTPUT_DIR"/css/
cp -R platform/mv3/extension/js/* "$OUTPUT_DIR"/js/
cp platform/mv3/"$PLATFORM"/ext-compat.js "$OUTPUT_DIR"/js/ 2>/dev/null || :
cp platform/mv3/"$PLATFORM"/ext-offscreen.js "$OUTPUT_DIR"/js/ 2>/dev/null || :
cp platform/mv3/"$PLATFORM"/css-api.js "$OUTPUT_DIR"/js/scripting/ 2>/dev/null || :
cp platform/mv3/"$PLATFORM"/css-user.js "$OUTPUT_DIR"/js/scripting/ 2>/dev/null || :
cp platform/mv3/extension/img/* "$OUTPUT_DIR"/img/
cp platform/mv3/"$PLATFORM"/img/* "$OUTPUT_DIR"/img/ 2>/dev/null || :
cp -R platform/mv3/extension/_locales "$OUTPUT_DIR"/
node tools/merge-mv3-locale-fallbacks.mjs "$OUTPUT_DIR"
cp platform/mv3/README.md "$OUTPUT_DIR/"

# Libraries
mkdir -p "$OUTPUT_DIR"/lib/codemirror
cp platform/mv3/extension/lib/codemirror/* \
    "$OUTPUT_DIR"/lib/codemirror/ 2>/dev/null || :
cp platform/mv3/extension/lib/codemirror/codemirror-ubol/dist/cm6.bundle.ubol.min.js \
    "$OUTPUT_DIR"/lib/codemirror/cm6.bundle.ublock-plus.min.js
cp platform/mv3/extension/lib/codemirror/codemirror.LICENSE \
    "$OUTPUT_DIR"/lib/codemirror/
cp platform/mv3/extension/lib/codemirror/codemirror-ubol/LICENSE \
    "$OUTPUT_DIR"/lib/codemirror/codemirror-quickstart.LICENSE
mkdir -p "$OUTPUT_DIR"/lib/csstree
cp "$UBO_DIR"/src/lib/csstree/* "$OUTPUT_DIR"/lib/csstree/
cp platform/mv3/extension/lib/s14e-serializer/s14e-serializer.js \
    "$OUTPUT_DIR"/lib/
cp platform/mv3/extension/lib/s14e-serializer/LICENSE \
    "$OUTPUT_DIR"/lib/s14e-serializer.LICENSE

echo "*** uBlock Plus+ MV3: Generating rulesets"
cp "$UBO_DIR"/src/lib/publicsuffixlist/publicsuffixlist.js "$OUTPUT_DIR"/lib/
RULESET_BUILD_DIR=$(mktemp -d)
mkdir -p "$RULESET_BUILD_DIR"
./tools/make-nodejs.sh "$RULESET_BUILD_DIR"
cp platform/mv3/*.json "$RULESET_BUILD_DIR"/
cp platform/mv3/*.js "$RULESET_BUILD_DIR"/
cp platform/mv3/*.mjs "$RULESET_BUILD_DIR"/
cp platform/mv3/extension/js/ubo-parser.js "$RULESET_BUILD_DIR"/js/
cp platform/mv3/extension/js/compiled-popup-matcher.js "$RULESET_BUILD_DIR"/js/
cp platform/mv3/extension/js/utils.js "$RULESET_BUILD_DIR"/js/
# make-rulesets imports offscreen/fetch-list.js, whose fetch-policy module
# lives one directory above the copied offscreen tree.
cp platform/mv3/extension/js/imported-fetch-policy.js "$RULESET_BUILD_DIR"/js/
cp "$UBO_DIR"/src/lib/punycode.js "$RULESET_BUILD_DIR"/js/
cp -R "$UBO_DIR"/src/lib/regexanalyzer "$RULESET_BUILD_DIR"/js/
cp -R "$UBO_DIR"/src/js/resources "$RULESET_BUILD_DIR"/js/
cp -R platform/mv3/scriptlets "$RULESET_BUILD_DIR"/
cp -R platform/mv3/extension/js/offscreen "$RULESET_BUILD_DIR"/js/
cp "$UBO_DIR"/src/js/regex-analyzer.js "$RULESET_BUILD_DIR"/js/offscreen/
mkdir -p "$RULESET_BUILD_DIR"/web_accessible_resources
cp "$UBO_DIR"/src/web_accessible_resources/* "$RULESET_BUILD_DIR"/web_accessible_resources/
cp -R platform/mv3/"$PLATFORM" "$RULESET_BUILD_DIR"/

cd "$RULESET_BUILD_DIR"
node --no-warnings make-rulesets.js output="$OUTPUT_DIR" platform="$PLATFORM"
if [ -n "$BEFORE" ]; then
    echo "*** uBlock Plus+ MV3: salvaging rule ids to minimize diff size"
    echo "    before=$BEFORE/$PLATFORM"
    echo "    after=$OUTPUT_DIR"
    node salvage-ruleids.mjs before="$BEFORE"/"$PLATFORM" after="$OUTPUT_DIR"
fi
cd - > /dev/null
rm -rf "$RULESET_BUILD_DIR"

echo "*** uBlock Plus+ $PLATFORM: extension ready"
echo "Extension location: $OUTPUT_DIR/"

# Local build
tmp_manifest=$(mktemp)
chmod '=rw' "$tmp_manifest"
if [ -z "$TAGNAME" ]; then
    TAGNAME="$(jq -r .version "$OUTPUT_DIR"/manifest.json)"
    # Enable DNR rule debugging
    jq 'if (.permissions | index("declarativeNetRequestFeedback")) then . else .permissions += ["declarativeNetRequestFeedback"] end' \
        "$OUTPUT_DIR/manifest.json" > "$tmp_manifest" \
        && mv "$tmp_manifest" "$OUTPUT_DIR/manifest.json"
    # Use a different extension id than the official one
    if [ "$PLATFORM" = "firefox" ]; then
        jq '.browser_specific_settings.gecko.id = "ublock-plus-dev@kayurachann.github.io"' "$OUTPUT_DIR/manifest.json"  > "$tmp_manifest" \
            && mv "$tmp_manifest" "$OUTPUT_DIR/manifest.json"
    fi
else
    jq --arg version "${TAGNAME}" '.version = $version' "$OUTPUT_DIR/manifest.json"  > "$tmp_manifest" \
        && mv "$tmp_manifest" "$OUTPUT_DIR/manifest.json"
    rm -rf "$OUTPUT_DIR/rulesets/debug"
fi

# Platform-specific steps
if [ "$PLATFORM" = "edge" ]; then
    # For Edge, declared rulesets must be at package root
    echo "*** uBlock Plus+ edge: Modify reference implementation for Edge compatibility"
    mv "$OUTPUT_DIR"/rulesets/main/* "$OUTPUT_DIR/"
    rmdir "$OUTPUT_DIR/rulesets/main"
    node platform/mv3/edge/patch-extension.js packageDir="$OUTPUT_DIR"
elif [ "$PLATFORM" = "safari" ]; then
    # For Safari, we must fix the package for compliance
    node platform/mv3/safari/patch-extension.js packageDir="$OUTPUT_DIR"
fi

if [ "$FULL" = "yes" ]; then
    EXTENSION="zip"
    if [ "$PLATFORM" = "firefox" ]; then
        EXTENSION="xpi"
    fi
    echo "*** uBlock Plus+ MV3: Creating publishable package..."
    PACKAGE_NAME="uBlock-Plus_$TAGNAME.$PLATFORM.$EXTENSION"
    PACKAGE_DIR=$(mktemp -d)
    mkdir -p "$PACKAGE_DIR"
    cp -R "$OUTPUT_DIR"/* "$PACKAGE_DIR"/
    cd "$PACKAGE_DIR" > /dev/null
    rm -f ./log.txt
    zip "$PACKAGE_NAME" -qr ./*
    cd - > /dev/null
    cp "$PACKAGE_DIR"/"$PACKAGE_NAME" dist/build/
    rm -rf "$PACKAGE_DIR"
    (
        cd dist/build
        if command -v sha256sum >/dev/null 2>&1; then
            sha256sum "$PACKAGE_NAME" > "$PACKAGE_NAME.sha256"
        else
            shasum -a 256 "$PACKAGE_NAME" > "$PACKAGE_NAME.sha256"
        fi
    )
    echo "Package location: $(pwd)/dist/build/$PACKAGE_NAME"
    echo "Checksum location: $(pwd)/dist/build/$PACKAGE_NAME.sha256"
fi
