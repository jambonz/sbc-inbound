insert into webhooks(webhook_sid, url, username, password) values('90dda62e-0ea2-47d1-8164-5bd49003476c', 'http://127.0.0.1:4000/auth', 'foo', 'bar');

insert into service_providers (service_provider_sid, name, root_domain, registration_hook_sid) 
values ('3f35518f-5a0d-4c2e-90a5-2407bb3b36f0', 'SP A', 'jambonz.org', '90dda62e-0ea2-47d1-8164-5bd49003476c');
insert into accounts(account_sid, service_provider_sid, name, sip_realm, registration_hook_sid)
values ('ed649e33-e771-403a-8c99-1780eabbc803', '3f35518f-5a0d-4c2e-90a5-2407bb3b36f0', 'test account', 'sip.example.com', '90dda62e-0ea2-47d1-8164-5bd49003476c');

insert into voip_carriers (voip_carrier_sid, name) values ('287c1452-620d-4195-9f19-c9814ef90d78', 'westco');
insert into sip_gateways (sip_gateway_sid, voip_carrier_sid, ipv4, inbound, outbound) 
values ('124a5339-c62c-4075-9e19-f4de70a96597', '287c1452-620d-4195-9f19-c9814ef90d78', '172.38.0.20', true, true);
insert into sip_gateways (sip_gateway_sid, voip_carrier_sid, ipv4, port, inbound, outbound) 
values ('efbc4830-57cd-4c78-a56f-d64fdf210fe8', '287c1452-620d-4195-9f19-c9814ef90d78', '3.3.3.3', 5062, false, true);

insert into webhooks(webhook_sid, url) values('4d7ce0aa-5ead-4e61-9a6b-3daa732218b1', 'http://example.com/status');
insert into accounts (account_sid, name, service_provider_sid)
values ('ee9d7d49-b3e4-4fdb-9d66-661149f717e8', 'Account A1', '3f35518f-5a0d-4c2e-90a5-2407bb3b36f0');
insert into applications (application_sid, name, account_sid, call_hook_sid, call_status_hook_sid)
values ('3b43e39f-4346-4218-8434-a53130e8be49', 'test', 'ee9d7d49-b3e4-4fdb-9d66-661149f717e8', '90dda62e-0ea2-47d1-8164-5bd49003476c', '4d7ce0aa-5ead-4e61-9a6b-3daa732218b1');

insert into voip_carriers (voip_carrier_sid, name, account_sid, application_sid) values ('999c1452-620d-4195-9f19-c9814ef90d78', 'customer PBX', 'ee9d7d49-b3e4-4fdb-9d66-661149f717e8', '3b43e39f-4346-4218-8434-a53130e8be49');
insert into sip_gateways (sip_gateway_sid, voip_carrier_sid, ipv4, inbound, outbound) 
values ('888a5339-c62c-4075-9e19-f4de70a96597', '999c1452-620d-4195-9f19-c9814ef90d78', '172.38.0.21', true, false);
