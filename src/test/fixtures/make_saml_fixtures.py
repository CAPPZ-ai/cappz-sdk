"""Generate signed SAML fixtures (src/test/fixtures/saml-signed.json) with signxml (lxml C14N), an implementation independent of CAPPZ.

    python -m venv venv && venv/bin/pip install signxml cryptography
    venv/bin/python -I src/test/fixtures/make_saml_fixtures.py src/test/fixtures/saml-signed.json

Keys are generated per run and never stored; only the certificates and signed documents are kept."""
import json, sys, datetime
from lxml import etree
from signxml import XMLSigner, XMLVerifier
from cryptography import x509
from cryptography.x509.oid import NameOID
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa, ec

def cert_for(key, cn):
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, cn)])
    now = datetime.datetime(2026, 1, 1)
    return (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
            .serial_number(1000).not_valid_before(now).not_valid_after(now + datetime.timedelta(days=3650))
            .sign(key, hashes.SHA256()))

ACS = "https://saas.example.com/saml/acs/acme"
def response(tenant_issuer, aid, rid, sig_in, audience="https://saas.example.com/saml/acme", acs=ACS):
    a_sig = '<ds:Signature Id="placeholder"/>' if sig_in == "assertion" else ""
    r_sig = '<ds:Signature Id="placeholder"/>' if sig_in == "response" else ""
    # Namespaces declared on the root and used below (exclusive C14N must re-declare them), odd attribute order, whitespace.
    return f'''<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" Version="2.0" ID="{rid}" IssueInstant="2026-11-09T11:59:55Z" Destination="{acs}">
  <saml:Issuer>{tenant_issuer}</saml:Issuer>{r_sig}
  <samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>
  <saml:Assertion Version="2.0" ID="{aid}" IssueInstant="2026-11-09T11:59:55Z">
    <saml:Issuer>{tenant_issuer}</saml:Issuer>{a_sig}
    <saml:Subject>
      <saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">alice@acme.example</saml:NameID>
      <saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData NotOnOrAfter="2026-11-09T12:05:00Z" Recipient="{acs}"/></saml:SubjectConfirmation>
    </saml:Subject>
    <saml:Conditions NotBefore="2026-11-09T11:59:00Z" NotOnOrAfter="2026-11-09T12:05:00Z"><saml:AudienceRestriction><saml:Audience>{audience}</saml:Audience></saml:AudienceRestriction></saml:Conditions>
    <saml:AttributeStatement><saml:Attribute Name="role"><saml:AttributeValue xsi:type="xs:string">admin &amp; &lt;owner&gt; "q"</saml:AttributeValue></saml:Attribute></saml:AttributeStatement>
  </saml:Assertion>
</samlp:Response>'''

def sign(xml, key, cert, ref, alg, digest="sha256"):
    root = etree.fromstring(xml.encode())
    signer = XMLSigner(signature_algorithm=alg, digest_algorithm=digest, c14n_algorithm="http://www.w3.org/2001/10/xml-exc-c14n#")
    signer.namespaces = {"ds": "http://www.w3.org/2000/09/xmldsig#"}
    signed = signer.sign(root, key=key, cert=[cert], reference_uri=ref)
    pem = cert.public_bytes(serialization.Encoding.PEM)
    XMLVerifier().verify(signed, x509_cert=pem, expect_references=1)  # the reference implementation agrees
    return etree.tostring(signed).decode()

rsa_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
rsa_cert = cert_for(rsa_key, "idp.acme.example")
ec_key = ec.generate_private_key(ec.SECP256R1())
ec_cert = cert_for(ec_key, "idp.globex.example")
other_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
other_cert = cert_for(other_key, "idp.globex-rsa.example")
pem = lambda c: c.public_bytes(serialization.Encoding.PEM).decode()

ACME = "https://idp.acme.example/saml"
GLOBEX = "https://idp.globex.example/saml"
out = {
  "certs": {"acme": pem(rsa_cert), "globex": pem(ec_cert), "globexRsa": pem(other_cert)},
  "acmeAssertionSigned": sign(response(ACME, "_acme_a1", "_acme_r1", "assertion"), rsa_key, rsa_cert, "_acme_a1", "rsa-sha256"),
  "acmeResponseSigned": sign(response(ACME, "_acme_a2", "_acme_r2", "response"), rsa_key, rsa_cert, "_acme_r2", "rsa-sha256"),
  "acmeSha512": sign(response(ACME, "_acme_a3", "_acme_r3", "assertion"), rsa_key, rsa_cert, "_acme_a3", "rsa-sha512", "sha512"),
  "globexEcdsa": sign(response(GLOBEX, "_glx_a1", "_glx_r1", "assertion", audience="https://saas.example.com/saml/globex", acs="https://saas.example.com/saml/acs/globex"), ec_key, ec_cert, "_glx_a1", "ecdsa-sha256"),
  # Globex's IdP, validly signed, but aimed at ACME's ACS and audience: the cross-tenant login.
  "globexIntoAcme": sign(response(GLOBEX, "_glx_a2", "_glx_r2", "assertion"), ec_key, ec_cert, "_glx_a2", "ecdsa-sha256"),
  "metadataAcme": f'''<?xml version="1.0"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="{ACME}">
  <md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol" WantAuthnRequestsSigned="false">
    <md:KeyDescriptor use="signing"><ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:X509Data><ds:X509Certificate>{"".join(pem(rsa_cert).splitlines()[1:-1])}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>
    <md:KeyDescriptor use="encryption"><ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:X509Data><ds:X509Certificate>{"".join(pem(other_cert).splitlines()[1:-1])}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>
    <md:NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</md:NameIDFormat>
    <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://idp.acme.example/sso"/>
  </md:IDPSSODescriptor>
</md:EntityDescriptor>''',
}
json.dump(out, open(sys.argv[1], "w"), indent=1)
print("ok", len(out))
