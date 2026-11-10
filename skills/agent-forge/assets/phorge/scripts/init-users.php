#!/usr/bin/env php
<?php
// Bootstrap Phorge inside the install dir.
// This file is copied to /opt/phorge/phorge/scripts/init-users.php at build time,
// so dirname(__FILE__) is the standard Phorge scripts/ location.
require_once dirname(__FILE__).'/__init_script__.php';

$args = new PhutilArgumentParser($argv);
$args->setSynopsis(<<<EOSYNOPSIS
**init-users.php** [options]

Idempotently create an admin account and an agent (system bot) account,
enable username/password login, then mint a standard Conduit API token for
the agent. Designed to be safe to re-run on every container boot.
EOSYNOPSIS
);
$args->parseStandardArguments();
$args->parse(
  array(
    array(
      'name' => 'admin-username',
      'param' => 'name',
      'help' => 'Admin username.',
      'default' => 'admin',
    ),
    array(
      'name' => 'admin-email',
      'param' => 'email',
      'help' => 'Admin email (verified on create).',
      'default' => 'admin@example.com',
    ),
    array(
      'name' => 'admin-realname',
      'param' => 'realname',
      'help' => 'Admin real name.',
      'default' => 'Administrator',
    ),
    array(
      'name' => 'admin-password',
      'param' => 'password',
      'help' => 'Initial admin password (will be stored hashed).',
      'default' => '',
    ),
    array(
      'name' => 'agent-username',
      'param' => 'name',
      'help' => 'Agent (bot) username.',
      'default' => 'agent',
    ),
    array(
      'name' => 'agent-email',
      'param' => 'email',
      'help' => 'Agent email (verified on create).',
      'default' => 'agent@example.com',
    ),
    array(
      'name' => 'agent-realname',
      'param' => 'realname',
      'help' => 'Agent real name.',
      'default' => 'Agent',
    ),
    array(
      'name' => 'token-out',
      'param' => 'path',
      'help' => 'Write the agent Conduit API token to this path.',
      'default' => '',
    ),
  )
);

$viewer = PhabricatorUser::getOmnipotentUser();

function find_user($viewer, $username) {
  return id(new PhabricatorPeopleQuery())
    ->setViewer($viewer)
    ->withUsernames(array($username))
    ->executeOne();
}

function ensure_user($viewer, $username, $email, $realname, $is_admin, $is_system_agent) {
  $existing = find_user($viewer, $username);
  if ($existing) {
    echo "user '{$username}' already exists (phid={$existing->getPHID()})\n";
    return $existing;
  }

  $user = id(new PhabricatorUser())
    ->setUsername($username)
    ->setRealName($realname)
    ->setIsApproved(1);

  if ($is_admin) {
    $user->setIsAdmin(1);
  }
  if ($is_system_agent) {
    $user->setIsSystemAgent(1);
  }

  $email_object = id(new PhabricatorUserEmail())
    ->setAddress($email)
    ->setIsVerified(1);

  id(new PhabricatorUserEditor())
    ->setActor($viewer)
    ->createNewUser($user, $email_object);

  echo "created user '{$username}' (phid={$user->getPHID()})\n";
  return $user;
}

function maybe_set_password($viewer, PhabricatorUser $user, $password) {
  if ($password === '' || $password === null) {
    return;
  }
  if (!class_exists('PhabricatorAuthPassword')) {
    echo "warn: PhabricatorAuthPassword not available; skipping password set\n";
    return;
  }

  $envelope = new PhutilOpaqueEnvelope($password);

  $existing = id(new PhabricatorAuthPasswordQuery())
    ->setViewer($viewer)
    ->withObjectPHIDs(array($user->getPHID()))
    ->withPasswordTypes(array(PhabricatorAuthPassword::PASSWORD_TYPE_ACCOUNT))
    ->withIsRevoked(false)
    ->execute();

  if ($existing) {
    echo "password already set for '{$user->getUsername()}'; skipping\n";
    return;
  }

  $password_object = PhabricatorAuthPassword::initializeNewPassword(
    $user,
    PhabricatorAuthPassword::PASSWORD_TYPE_ACCOUNT
  );

  $password_object
    ->setPassword($envelope, $user)
    ->save();

  echo "password set for '{$user->getUsername()}'\n";
}

function ensure_conduit_token($viewer, PhabricatorUser $user) {
  $existing = id(new PhabricatorConduitTokenQuery())
    ->setViewer($viewer)
    ->withObjectPHIDs(array($user->getPHID()))
    ->withTokenTypes(array(PhabricatorConduitToken::TYPE_STANDARD))
    ->withExpired(false)
    ->execute();
  if ($existing) {
    $tok = head($existing);
    echo "conduit token already exists for '{$user->getUsername()}'\n";
    return $tok;
  }

  $tok = PhabricatorConduitToken::initializeNewToken(
    $user->getPHID(),
    PhabricatorConduitToken::TYPE_STANDARD
  );
  $tok->save();
  echo "minted conduit token for '{$user->getUsername()}'\n";
  return $tok;
}

// Enable the Username/Password auth provider so the admin can log in to the
// web UI right away (otherwise Phorge needs `bin/auth recover` first).
function ensure_password_auth($viewer) {
  $existing = id(new PhabricatorAuthProviderConfigQuery())
    ->setViewer($viewer)
    ->withProviderClasses(array('PhabricatorPasswordAuthProvider'))
    ->execute();
  if ($existing) {
    echo "password auth provider already configured\n";
    return;
  }
  $provider = new PhabricatorPasswordAuthProvider();
  // Same defaults the web UI uses (PhabricatorAuthEditController); type and
  // domain are NOT NULL columns that getDefaultProviderConfig() leaves empty.
  $config = $provider->getDefaultProviderConfig();
  $config
    ->setProviderType($provider->getProviderType())
    ->setProviderDomain($provider->getProviderDomain())
    ->setIsEnabled(1)
    ->setShouldAllowLogin(1)
    ->setShouldAllowRegistration(0)
    ->setShouldAllowLink(1)
    ->setShouldAllowUnlink(1)
    ->save();
  echo "enabled username/password auth provider\n";
}

ensure_password_auth($viewer);

$admin = ensure_user(
  $viewer,
  $args->getArg('admin-username'),
  $args->getArg('admin-email'),
  $args->getArg('admin-realname'),
  true,
  false
);
maybe_set_password($viewer, $admin, $args->getArg('admin-password'));

$agent = ensure_user(
  $viewer,
  $args->getArg('agent-username'),
  $args->getArg('agent-email'),
  $args->getArg('agent-realname'),
  false,
  true
);

$token = ensure_conduit_token($viewer, $agent);
$token_string = $token->getToken();

$out_path = $args->getArg('token-out');
if ($out_path !== '') {
  Filesystem::writeFile($out_path, $token_string."\n");
  echo "wrote token to {$out_path}\n";
}

echo "\n";
echo "admin    : {$admin->getUsername()} <{$args->getArg('admin-email')}>\n";
echo "agent    : {$agent->getUsername()} <{$args->getArg('agent-email')}>\n";
