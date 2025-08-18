-- create our products
insert into products (product_sid, name, category)
values
('c4403cdb-8e75-4b27-9726-7d8315e3216d', 'concurrent call session', 'voice_call_session'),
('2c815913-5c26-4004-b748-183b459329df', 'registered device', 'device'),
('35a9fb10-233d-4eb9-aada-78de5814d680', 'api call', 'api_rate');

insert into webhooks(webhook_sid, url, username, password) values('90dda62e-0ea2-47d1-8164-5bd49003476c', 'http://127.0.0.1:4000/auth', 'foo', 'bar');

insert into service_providers (service_provider_sid, name, root_domain, registration_hook_sid) 
values ('3f35518f-5a0d-4c2e-90a5-2407bb3b36f0', 'SP A', 'jambonz.org', '90dda62e-0ea2-47d1-8164-5bd49003476c');
insert into service_provider_limits (service_provider_limits_sid, service_provider_sid, category, quantity) 
values ('a79d3ade-e0da-4461-80f3-7c73f01e18b4', '3f35518f-5a0d-4c2e-90a5-2407bb3b36f0', 'voice_call_session', 1);

insert into accounts(account_sid, service_provider_sid, name, sip_realm, registration_hook_sid, webhook_secret)
values ('ed649e33-e771-403a-8c99-1780eabbc803', '3f35518f-5a0d-4c2e-90a5-2407bb3b36f0', 'test account', 'jambonz.org', '90dda62e-0ea2-47d1-8164-5bd49003476c', 'foobar');
insert into account_subscriptions(account_subscription_sid, account_sid, pending)
values ('f4e1848d-3ff8-40eb-b9c1-30e1ef053f94','ed649e33-e771-403a-8c99-1780eabbc803',0);
insert into account_products(account_product_sid, account_subscription_sid, product_sid,quantity)
values ('f23ff996-6534-4aba-8666-4b347391eca2', 'f4e1848d-3ff8-40eb-b9c1-30e1ef053f94', 'c4403cdb-8e75-4b27-9726-7d8315e3216d', 10);

insert into voip_carriers (voip_carrier_sid, name, account_sid, service_provider_sid) 
values ('287c1452-620d-4195-9f19-c9814ef90d78', 'westco', 'ed649e33-e771-403a-8c99-1780eabbc803', '3f35518f-5a0d-4c2e-90a5-2407bb3b36f0');
insert into sip_gateways (sip_gateway_sid, voip_carrier_sid, ipv4, inbound, outbound) 
values ('124a5339-c62c-4075-9e19-f4de70a96597', '287c1452-620d-4195-9f19-c9814ef90d78', '172.38.0.20', true, true);
insert into sip_gateways (sip_gateway_sid, voip_carrier_sid, ipv4, port, inbound, outbound) 
values ('efbc4830-57cd-4c78-a56f-d64fdf210fe8', '287c1452-620d-4195-9f19-c9814ef90d78', '3.3.3.3', 5062, false, true);

insert into webhooks(webhook_sid, url) values('4d7ce0aa-5ead-4e61-9a6b-3daa732218b1', 'http://example.com/status');

insert into accounts (account_sid, name, service_provider_sid, webhook_secret, sip_realm)
values ('ee9d7d49-b3e4-4fdb-9d66-661149f717e8', 'Account A1', '3f35518f-5a0d-4c2e-90a5-2407bb3b36f0', 'foobar', 'delta.sip.jambonz.org');
insert into account_subscriptions(account_subscription_sid, account_sid, pending)
values ('4f3853e6-d8b0-43de-ba62-d9279801695d','ee9d7d49-b3e4-4fdb-9d66-661149f717e8',0);
insert into account_products(account_product_sid, account_subscription_sid, product_sid,quantity)
values ('61840638-ccde-4bc5-b645-5d32718c68a5', '4f3853e6-d8b0-43de-ba62-d9279801695d', 'c4403cdb-8e75-4b27-9726-7d8315e3216d', 10);

insert into accounts (account_sid, name, service_provider_sid, webhook_secret, sip_realm)
values ('d7cc37cb-d152-49ef-a51b-485f6e917089', 'Account A1', '3f35518f-5a0d-4c2e-90a5-2407bb3b36f0', 'foobar', 'echo.sip.jambonz.org');
insert into account_subscriptions(account_subscription_sid, account_sid, pending)
values ('73bbcc5d-512f-4cea-8535-9a6e3d2bd19d','d7cc37cb-d152-49ef-a51b-485f6e917089',0);
insert into account_products(account_product_sid, account_subscription_sid, product_sid,quantity)
values ('92f137f7-4bc3-4157-b096-6817e54b1874', '73bbcc5d-512f-4cea-8535-9a6e3d2bd19d', 'c4403cdb-8e75-4b27-9726-7d8315e3216d', 0);
insert into account_limits(account_limits_sid, account_sid, category, quantity) values('a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d', 'd7cc37cb-d152-49ef-a51b-485f6e917089', 'voice_call_session', 0);

insert into voip_carriers (voip_carrier_sid, name, account_sid, service_provider_sid) 
values ('9b1abdc7-0220-4964-bc66-32b5c70cd9ab', 'westco', 'd7cc37cb-d152-49ef-a51b-485f6e917089', '3f35518f-5a0d-4c2e-90a5-2407bb3b36f0');
insert into sip_gateways (sip_gateway_sid, voip_carrier_sid, ipv4, inbound, outbound) 
values ('12f401d9-cbb1-49e5-bd33-cefbca0badc3', '9b1abdc7-0220-4964-bc66-32b5c70cd9ab', '172.38.0.20', true, true);
insert into sip_gateways (sip_gateway_sid, voip_carrier_sid, ipv4, port, inbound, outbound) 
values ('1401eb72-0daf-4471-aba6-038a0a2587b3', '9b1abdc7-0220-4964-bc66-32b5c70cd9ab', '3.3.3.3', 5062, false, true);


insert into applications (application_sid, name, account_sid, call_hook_sid, call_status_hook_sid)
values ('3b43e39f-4346-4218-8434-a53130e8be49', 'test', 'ee9d7d49-b3e4-4fdb-9d66-661149f717e8', '90dda62e-0ea2-47d1-8164-5bd49003476c', '4d7ce0aa-5ead-4e61-9a6b-3daa732218b1');

insert into voip_carriers (voip_carrier_sid, name, account_sid, application_sid, service_provider_sid) 
values ('999c1452-620d-4195-9f19-c9814ef90d78', 'customer PBX', 'ee9d7d49-b3e4-4fdb-9d66-661149f717e8', '3b43e39f-4346-4218-8434-a53130e8be49', '3f35518f-5a0d-4c2e-90a5-2407bb3b36f0');
insert into sip_gateways (sip_gateway_sid, voip_carrier_sid, ipv4, inbound, outbound) 
values ('888a5339-c62c-4075-9e19-f4de70a96597', '999c1452-620d-4195-9f19-c9814ef90d78', '172.38.0.21', true, false);
 
insert into phone_numbers (phone_number_sid, number, voip_carrier_sid, account_sid)
values ('999a5339-c62c-4075-9e19-f4de70a96597', '16173333456', '287c1452-620d-4195-9f19-c9814ef90d78', 'ed649e33-e771-403a-8c99-1780eabbc803');

insert into phone_numbers (phone_number_sid, number, voip_carrier_sid, account_sid)
values ('29543d4e-d959-4a25-836a-cde7161cd7d5', '1508222*', '287c1452-620d-4195-9f19-c9814ef90d78', 'ed649e33-e771-403a-8c99-1780eabbc803');
insert into phone_numbers (phone_number_sid, number, voip_carrier_sid, account_sid)
values ('dddd5c34-feae-4d70-98af-bb4d1f8dc965', '1508*', '287c1452-620d-4195-9f19-c9814ef90d78', 'ed649e33-e771-403a-8c99-1780eabbc803');
insert into phone_numbers (phone_number_sid, number, voip_carrier_sid, account_sid)
values ('d458bf7a-bcea-47b2-ac96-66dfc9c5c220', '150822233*', '287c1452-620d-4195-9f19-c9814ef90d78', 'ed649e33-e771-403a-8c99-1780eabbc803');

insert into phone_numbers (phone_number_sid, number, voip_carrier_sid, account_sid)
values ('f7ad205d-b92f-4363-8160-f8b5216b40d3', '15083871234', '287c1452-620d-4195-9f19-c9814ef90d78', 'd7cc37cb-d152-49ef-a51b-485f6e917089');

insert into phone_numbers (phone_number_sid, number, voip_carrier_sid, account_sid, application_sid)
values ('c17d5a7d-9328-4663-92c0-f65aa8381264', '12125551212', '287c1452-620d-4195-9f19-c9814ef90d78', 'ed649e33-e771-403a-8c99-1780eabbc803', '3b43e39f-4346-4218-8434-a53130e8be49');

-- two accounts that both have the same carrier with default routing (ambiguity test)
insert into accounts (account_sid, name, service_provider_sid, webhook_secret, sip_realm)
values ('239d7d49-b3e4-4fdb-9d66-661149f717e8', 'Account B1', '3f35518f-5a0d-4c2e-90a5-2407bb3b36f0', 'foobar', 'echo2.sip.jambonz.org');
insert into accounts (account_sid, name, service_provider_sid, webhook_secret, sip_realm)
values ('909d7d49-b3e4-4fdb-9d66-661149f717e8', 'Account B2', '3f35518f-5a0d-4c2e-90a5-2407bb3b36f0', 'foobar', 'foxtrot.sip.jambonz.org');

insert into applications (application_sid, name, account_sid, call_hook_sid, call_status_hook_sid)
values ('8843e39f-4346-4218-8434-a53130e8be49', 'test', '239d7d49-b3e4-4fdb-9d66-661149f717e8', '90dda62e-0ea2-47d1-8164-5bd49003476c', '4d7ce0aa-5ead-4e61-9a6b-3daa732218b1');
insert into applications (application_sid, name, account_sid, call_hook_sid, call_status_hook_sid)
values ('7743e39f-4346-4218-8434-a53130e8be49', 'test', '909d7d49-b3e4-4fdb-9d66-661149f717e8', '90dda62e-0ea2-47d1-8164-5bd49003476c', '4d7ce0aa-5ead-4e61-9a6b-3daa732218b1');

insert into voip_carriers (voip_carrier_sid, name, service_provider_sid, account_sid, application_sid) 
values ('731abdc7-0220-4964-bc66-32b5c70cd9ab', 'twilio-1', '3f35518f-5a0d-4c2e-90a5-2407bb3b36f0', '239d7d49-b3e4-4fdb-9d66-661149f717e8', '8843e39f-4346-4218-8434-a53130e8be49');
insert into voip_carriers (voip_carrier_sid, name, service_provider_sid, account_sid, application_sid) 
values ('987abdc7-0220-4964-bc66-32b5c70cd9ab', 'twilio-2', '3f35518f-5a0d-4c2e-90a5-2407bb3b36f0', '909d7d49-b3e4-4fdb-9d66-661149f717e8', '7743e39f-4346-4218-8434-a53130e8be49');

insert into sip_gateways (sip_gateway_sid, voip_carrier_sid, ipv4, inbound, outbound) 
values ('664a5339-c62c-4075-9e19-f4de70a96597', '731abdc7-0220-4964-bc66-32b5c70cd9ab', '172.38.0.40', true, false);
insert into sip_gateways (sip_gateway_sid, voip_carrier_sid, ipv4, inbound, outbound) 
values ('554a5339-c62c-4075-9e19-f4de70a96597', '987abdc7-0220-4964-bc66-32b5c70cd9ab', '172.38.0.40', true, false);

-- voip carrier belonging to all accounts
insert into voip_carriers (voip_carrier_sid, name, service_provider_sid) 
values ('voip100', 'test-voip-carrier', '3f35518f-5a0d-4c2e-90a5-2407bb3b36f0');
insert into sip_gateways (sip_gateway_sid, voip_carrier_sid, ipv4, inbound, outbound) 
values ('sip100', 'voip100', '172.38.0.50', true, false);

insert into voip_carriers (voip_carrier_sid, name, service_provider_sid) 
values ('voip101', 'test-voip-carrier-101', '3f35518f-5a0d-4c2e-90a5-2407bb3b36f0');
insert into sip_gateways (sip_gateway_sid, voip_carrier_sid, ipv4, inbound, outbound) 
values ('sip101', 'voip101', '172.38.0.50', true, false);
insert into sip_gateways (sip_gateway_sid, voip_carrier_sid, ipv4, inbound, outbound) 
values ('sip102', 'voip101', '172.38.0.51', true, false);

insert into applications (application_sid, name, account_sid, call_hook_sid, call_status_hook_sid)
values ('app100', 'app100', 'ee9d7d49-b3e4-4fdb-9d66-661149f717e8', '90dda62e-0ea2-47d1-8164-5bd49003476c', '90dda62e-0ea2-47d1-8164-5bd49003476c');
insert into applications (application_sid, name, account_sid, call_hook_sid, call_status_hook_sid)
values ('app101', 'app101', 'ee9d7d49-b3e4-4fdb-9d66-661149f717e8', '90dda62e-0ea2-47d1-8164-5bd49003476c', '90dda62e-0ea2-47d1-8164-5bd49003476c');
insert into phone_numbers (phone_number_sid, number, voip_carrier_sid, account_sid, application_sid)
values ('phone100', '^100', 'voip101', 'ee9d7d49-b3e4-4fdb-9d66-661149f717e8', 'app100');
insert into phone_numbers (phone_number_sid, number, voip_carrier_sid, account_sid, application_sid)
values ('phone101', '^10012', 'voip100', 'ee9d7d49-b3e4-4fdb-9d66-661149f717e8', 'app101');
-- insert an invalid regex pattern, the below pattern should be ignored during pattern
insert into phone_numbers (phone_number_sid, number, voip_carrier_sid, account_sid, application_sid)
values ('phone102', '\\dkjfhmdf\\', 'voip100', 'ee9d7d49-b3e4-4fdb-9d66-661149f717e8', 'app101');

-- account with a sip realm that is not associated with any voip carriers
insert into accounts (account_sid, name, service_provider_sid, webhook_secret, sip_realm)
values ('acct-100', 'Account 100', '3f35518f-5a0d-4c2e-90a5-2407bb3b36f0', 'foobar', 'ram.sip.jambonz.org');
