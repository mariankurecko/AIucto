import { CompanyIdentityConfig, ExtractedParty, IdentityMatchSummary } from "./types.js";
import { normalizeCompact, normalizeDigits, normalizeForMatching } from "./textNormalization.js";

function anyIncludes(haystack: string, needles: string[]): boolean {
  return needles.some((needle) => needle.length > 0 && haystack.includes(needle));
}

function normalizeAddress(identity: CompanyIdentityConfig): string[] {
  const variants = [
    `${identity.registeredAddress.street}, ${identity.registeredAddress.postalCode} ${identity.registeredAddress.city}`,
    `${identity.registeredAddress.street} ${identity.registeredAddress.postalCode} ${identity.registeredAddress.city}`,
    ...identity.registeredAddressVariants,
  ];
  return variants.map(normalizeForMatching);
}

export function matchEquisixIdentity(input: {
  identity: CompanyIdentityConfig;
  text: string;
  supplier: ExtractedParty;
  customer: ExtractedParty;
}): IdentityMatchSummary {
  const normalizedText = normalizeForMatching(input.text);
  const compactText = normalizeCompact(input.text);

  const names = input.identity.knownNames.map(normalizeForMatching);
  const registrationValues = [
    input.identity.companyRegistrationNumber.value,
    ...input.identity.companyRegistrationNumber.aliases,
  ].map(normalizeDigits);
  const taxValues = [
    input.identity.taxIdentificationNumber.value,
    ...input.identity.taxIdentificationNumber.aliases,
  ].map(normalizeDigits);
  const vatValues = [
    input.identity.vatIdentificationNumber.value,
    ...input.identity.vatIdentificationNumber.aliases,
  ].map(normalizeDigits);
  const emails = input.identity.knownEmails.map(normalizeForMatching);
  const addresses = normalizeAddress(input.identity);

  const parties = [input.supplier, input.customer];
  const legalName = anyIncludes(normalizedText, names) || parties.some((party) => names.includes(normalizeForMatching(party.legalName ?? "")));
  const registrationNumber =
    anyIncludes(compactText, registrationValues) ||
    parties.some((party) => registrationValues.includes(normalizeDigits(party.registrationNumber ?? "")));
  const taxId =
    anyIncludes(compactText, taxValues) ||
    parties.some((party) => taxValues.includes(normalizeDigits(party.taxId ?? "")));
  const vatId =
    anyIncludes(compactText, vatValues) ||
    parties.some((party) => vatValues.includes(normalizeDigits(party.vatId ?? "")));
  const address =
    anyIncludes(normalizedText, addresses) ||
    parties.some((party) => addresses.includes(normalizeForMatching(party.address ?? "")));
  const email =
    anyIncludes(normalizedText, emails) ||
    parties.some((party) => emails.includes(normalizeForMatching(party.email ?? "")));

  const matchedFields = [
    legalName ? "legal_name" : null,
    registrationNumber ? "company_registration_number" : null,
    taxId ? "tax_identification_number" : null,
    vatId ? "vat_identification_number" : null,
    address ? "registered_address" : null,
    email ? "known_email" : null,
  ].filter((value): value is string => Boolean(value));

  return {
    legalName,
    registrationNumber,
    taxId,
    vatId,
    address,
    email,
    matchedFields,
  };
}
