<?php

declare(strict_types=1);

$templatePath = $argv[1] ?? '/boot/config/plugins/dockerMan/templates-user/my-shelfstream.xml';
$containerName = $argv[2] ?? 'shelfstream';

$environmentJson = shell_exec(
    "docker inspect --format '{{json .Config.Env}}' " . escapeshellarg($containerName)
);

if ($environmentJson === null) {
    fwrite(STDERR, "Unable to inspect the ShelfStream container.\n");
    exit(1);
}

$environmentEntries = json_decode(trim($environmentJson), true, flags: JSON_THROW_ON_ERROR);
$environment = [];

foreach ($environmentEntries as $entry) {
    $separator = strpos($entry, '=');
    if ($separator !== false) {
        $environment[substr($entry, 0, $separator)] = substr($entry, $separator + 1);
    }
}

$template = simplexml_load_file($templatePath);
if ($template === false) {
    fwrite(STDERR, "Unable to read the ShelfStream Docker Manager template.\n");
    exit(1);
}

foreach ($template->Config as $config) {
    $target = (string) $config['Target'];
    if (array_key_exists($target, $environment)) {
        $config[0] = $environment[$target];
    }
}

if ($template->asXML($templatePath) === false) {
    fwrite(STDERR, "Unable to save the ShelfStream Docker Manager template.\n");
    exit(1);
}

echo "ShelfStream Docker Manager template synchronized.\n";
